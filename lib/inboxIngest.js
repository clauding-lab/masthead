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
  if (!envelope) return verdict('unknown_recipient', null, rawBytes);

  if (process.env.INGEST_DISABLED === '1') return verdict('disabled', null, rawBytes);

  const address = await repo.findAddressBySlug(envelope.slug);
  if (!address) return verdict('unknown_recipient', null, rawBytes);

  const userLimit = await limiter(`inbox:${address.userId}`, USER_LIMIT);
  if (!userLimit.allowed) return verdict('rate_limited', address, rawBytes);
  const globalLimit = await limiter('inbox:global', GLOBAL_LIMIT);
  if (!globalLimit.allowed) return verdict('rate_limited', address, rawBytes);

  if (rawBytes > MAX_RAW_BYTES) return verdict('message_too_large', address, rawBytes);

  const parsed = await parse(rawBuffer);
  if (!parsed) return verdict('unparseable', address, rawBytes);

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

  // Dedupe precedes quota (spec §5.1): insertMessage's UNIQUE(user_id,
  // dedupe_key) collision and the quota trigger are both evaluated inside
  // this single INSERT — there is no separate pre-quota check here to skip.
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
