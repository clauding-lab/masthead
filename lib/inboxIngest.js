// lib/inboxIngest.js — the ingest pipeline (spec §3/§5.1): the ONLY place
// that turns an authenticated raw email POST into a verdict for the
// Cloudflare Email Worker (Task 10) and, on the way, a row for
// lib/inboxRepo.js. The secret check happens at the ROUTE layer
// (lib/ingestAuth.js) — this file starts at envelope parsing and never sees
// the request itself.
//
// Insert-only landmine: this file must never call anything on `repo` beyond
// findAddressBySlug / insertMessage / markDeferred / clearDeferred. The last
// two are the only writes it ever issues, and both touch
// user_ingest_addresses, never user_inbox_messages — that table is
// insert-only, enforced by inboxRepo.insertMessage's plain INSERT plus the
// DB's own no-undelete trigger (spec §4.2).
import { findAddressBySlug, insertMessage, markDeferred, clearDeferred } from './inboxRepo.js';
import { parseEmail } from './emailParse.js';
import { sanitizeEmailHtml } from './sanitizeEmail.js';
import { checkRateLimit } from './rateLimit.js';
import { messageBytes } from './inboxSize.js';
import { INGEST_DOMAIN, MAX_RAW_BYTES, MAX_MESSAGE_BYTES, GRACE_MS } from './inboxConfig.js';

const defaultRepo = { findAddressBySlug, insertMessage, markDeferred, clearDeferred };

const ENVELOPE_RE = /^(.+)@(.+)$/;
const EXCERPT_MAX = 200;
const USER_LIMIT = { limit: 60, windowSec: 3600 };
const GLOBAL_LIMIT = { limit: 1000, windowSec: 3600 };
// Case 17 (spec §5 red-team): per-slug/per-user keys meter nothing an
// attacker probing for valid recipients cares about — a slug-enumeration
// (or domain-guessing) sweep never resolves to a known user_id, so it never
// touches USER_LIMIT/GLOBAL_LIMIT above. This bucket is the only thing that
// meters that traffic, shared across every request that would otherwise
// resolve to `unknown_recipient`.
const UNKNOWN_LIMIT = { limit: 120, windowSec: 3600 };

// Built via fromCharCode, never typed literally, and never spelled out as a
// Unicode escape sequence either (transcription hazard: a raw control byte
// does not survive every editor/transport, and even the escape-sequence
// spelling risks silently decoding to a raw byte in tooling that touches
// this file — same rule this module's tests follow).
const NUL = String.fromCharCode(0);

// Maps every verdict code (spec §3's SMTP response table) to its HTTP
// status. `disabled` and `rate_limited` are transient (429, same bucket as
// `over_quota`) so a sender's normal retry schedule IS the recovery path —
// never a bounce.
const STATUS_BY_CODE = {
  accepted: 201,
  duplicate: 200,
  unknown_recipient: 404,
  message_too_large: 413,
  unparseable: 422,
  over_quota: 429,
  over_quota_final: 507,
  rate_limited: 429,
  disabled: 429,
};

/**
 * `<slug>@INGEST_DOMAIN` (case-insensitive), with a `+suffix` on the local
 * part discarded — mirrors how plus-addressing is normally ignored for
 * routing. Returns null for anything that isn't a two-part address on our
 * domain, so a malformed or foreign envelope reads as an unknown recipient
 * rather than throwing.
 *
 * @param {unknown} envelopeTo
 * @returns {{ slug: string } | null}
 */
function parseEnvelope(envelopeTo) {
  if (typeof envelopeTo !== 'string') return null;
  const match = ENVELOPE_RE.exec(envelopeTo.toLowerCase());
  if (!match) return null;
  const [, localPart, domain] = match;
  if (domain !== INGEST_DOMAIN) return null;
  return { slug: localPart.replace(/\+.*$/, '') };
}

function stripHtmlTags(html) {
  return typeof html === 'string' ? html.replace(/<[^>]*>/g, ' ') : '';
}

/**
 * Plain-text preview: the text part when present, else the sanitised HTML
 * with tags stripped, collapsed to single spaces and clamped to 200 chars.
 * The list view never ships full bodies — that's the point of having an
 * excerpt column at all (spec §4.2).
 *
 * @param {string|null} text
 * @param {string} sanitizedHtml
 * @returns {string|null}
 */
function buildExcerpt(text, sanitizedHtml) {
  const source = text || stripHtmlTags(sanitizedHtml);
  const collapsed = (source || '').replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, EXCERPT_MAX) : null;
}

// split/join, not a regex literal — keeps the NUL character itself out of
// any pattern that would otherwise need to embed it.
function stripNul(value) {
  return typeof value === 'string' ? value.split(NUL).join('') : value;
}

// Defense in depth, not redundancy: sanitizeEmailHtml strips NUL from html
// only, and lib/emailParse.js passes text/html through verbatim by design
// (stripping there would hide the input from the storage layer, whose job
// this is). Postgres text columns cannot hold 0x00 at all, so every string
// field of the row gets one final blanket strip right before it reaches
// repo.insertMessage — this is the last point this file controls before the
// DB call (ledgered T5 carry-forward; Postgres text cannot store 0x00).
function stripNulRow(row) {
  const cleaned = {};
  for (const [key, value] of Object.entries(row)) {
    cleaned[key] = stripNul(value);
  }
  return cleaned;
}

// Log privacy (spec §8 rule 5): bodies, subjects, and slugs never logged —
// the address-row id is the only identifier, alongside the verdict code and
// the raw byte count.
function verdict(code, address, rawBytes) {
  console.log(`[ingest] ${code} row=${address?.id ?? 'none'} bytes=${rawBytes}`);
  return { status: STATUS_BY_CODE[code], code };
}

// Case 17: every path that would otherwise resolve to `unknown_recipient` —
// a malformed/foreign-domain envelope OR a domain-matched envelope whose
// slug doesn't resolve to a row — first consumes the shared `inbox:unknown`
// bucket. A denied bucket returns 429 rate_limited instead of 404 so a
// slug-enumeration sweep gets no signal distinguishing "wrong guess" from
// "we're throttling you" (no enumeration feedback), and so the Worker
// defers rather than bounces (transient, spec §3). A KNOWN slug never
// reaches this function at all — it resolves an address and moves on to
// USER_LIMIT/GLOBAL_LIMIT instead, so known-slug traffic never touches this
// bucket.
async function unknownRecipientVerdict(limiter, rawBytes) {
  const bucket = await limiter('inbox:unknown', UNKNOWN_LIMIT);
  if (!bucket.allowed) return verdict('rate_limited', null, rawBytes);
  return verdict('unknown_recipient', null, rawBytes);
}

/**
 * Turn one authenticated raw email POST into a verdict, per spec §3's SMTP
 * response table.
 *
 * @param {{ envelopeTo: string, rawBuffer: Buffer|Uint8Array|string }} input
 * @param {{
 *   repo?: { findAddressBySlug: Function, insertMessage: Function, markDeferred: Function, clearDeferred: Function },
 *   parse?: (rawBuffer: unknown) => Promise<object|null>,
 *   sanitize?: (html: string|null) => (string|Promise<string>),
 *   limiter?: (key: string, opts: { limit: number, windowSec: number }) => Promise<{ allowed: boolean }>,
 *   now?: () => number,
 * }} [deps]
 * @returns {Promise<{ status: number, code: string }>}
 */
export async function ingestEmail({ envelopeTo, rawBuffer }, deps = {}) {
  const repo = deps.repo || defaultRepo;
  const parse = deps.parse || parseEmail;
  const sanitize = deps.sanitize || sanitizeEmailHtml;
  const limiter = deps.limiter || checkRateLimit;
  const now = deps.now || Date.now;

  const rawBytes = Buffer.byteLength(rawBuffer ?? '');

  const envelope = parseEnvelope(envelopeTo);
  if (!envelope) return unknownRecipientVerdict(limiter, rawBytes);

  if (process.env.INGEST_DISABLED === '1') return verdict('disabled', null, rawBytes);

  const address = await repo.findAddressBySlug(envelope.slug);
  if (!address) return unknownRecipientVerdict(limiter, rawBytes);

  const userLimit = await limiter(`inbox:${address.userId}`, USER_LIMIT);
  if (!userLimit.allowed) return verdict('rate_limited', address, rawBytes);
  const globalLimit = await limiter('inbox:global', GLOBAL_LIMIT);
  if (!globalLimit.allowed) return verdict('rate_limited', address, rawBytes);

  if (rawBytes > MAX_RAW_BYTES) return verdict('message_too_large', address, rawBytes);

  const parsed = await parse(rawBuffer);
  if (!parsed) return verdict('unparseable', address, rawBytes);
  // RFC 5322 mandates a From header. A message that parses structurally but
  // carries no usable from address (no From header at all, `From:
  // undisclosed-recipients:;`, or an empty angle-address `From: "Name Only"
  // <>`) is deterministically malformed — from_email is NOT NULL at the DB,
  // so without this guard the row would fail insertMessage with 23502,
  // surface as a 500, and the Worker would defer it forever (infinite retry
  // against mail that will never parse correctly). 422 unparseable is the
  // honest, permanent verdict for mail that can never be fixed by retrying.
  if (!parsed.fromEmail) return verdict('unparseable', address, rawBytes);

  const sanitizedHtml = await sanitize(parsed.html);
  const sizeBytes = messageBytes(sanitizedHtml, parsed.text);
  if (sizeBytes > MAX_MESSAGE_BYTES) return verdict('message_too_large', address, rawBytes);

  const row = stripNulRow({
    userId: address.userId,
    fromEmail: parsed.fromEmail,
    fromName: parsed.fromName,
    subject: parsed.subject,
    html: sanitizedHtml,
    text: parsed.text,
    excerpt: buildExcerpt(parsed.text, sanitizedHtml),
    sizeBytes,
    webUrl: parsed.webUrl,
    unsubscribeUrl: parsed.unsubscribeUrl,
    authResults: parsed.authResults,
    dedupeKey: parsed.dedupeKey,
    messageId: parsed.messageId,
  });

  // Dedupe precedes quota (spec §5.1): enforce_inbox_quota is a BEFORE-row
  // trigger, and Postgres fires those before it checks constraints — left
  // alone, it would raise 'inbox quota exceeded' for a redelivered duplicate
  // at a full inbox before the UNIQUE(user_id, dedupe_key) index ever runs.
  // The trigger (supabase/migrations/20260731_create_inbox.sql) short-
  // circuits with `return new` the moment a row with this (user_id,
  // dedupe_key) already exists, so the INSERT falls through to constraint
  // checking, where the unique index — not the trigger — decides duplicates.
  // The ordering lives entirely in Postgres; there is no app-level check
  // here to get right or wrong. Verified live by
  // scripts/probe-inbox-custody.mjs's dedupe-precedes-quota probe.
  const insertVerdict = await repo.insertMessage(row);

  if (insertVerdict === 'duplicate') return verdict('duplicate', address, rawBytes);

  if (insertVerdict === 'inserted') {
    await repo.clearDeferred(address.userId);
    return verdict('accepted', address, rawBytes);
  }

  // insertVerdict === 'over_quota': grace ladder off the address's
  // PRE-EXISTING over_quota_since (the moment this user first started being
  // deferred, as returned by findAddressBySlug above) — never off a value
  // markDeferred may set as a side effect of THIS call, so a first-time
  // defer always lands within grace.
  await repo.markDeferred(address.userId);
  const since = address.overQuotaSince ? new Date(address.overQuotaSince).getTime() : null;
  const beyondGrace = since !== null && now() - since > GRACE_MS;
  return verdict(beyondGrace ? 'over_quota_final' : 'over_quota', address, rawBytes);
}
