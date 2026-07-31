import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';

// Storage-facing clamps. Everything that reaches these fields comes from a
// stranger's SMTP client, so nothing is trusted for length or for staying
// inside the printable range.
const MAX_FROM_EMAIL = 320;
const MAX_FROM_NAME = 200;
const MAX_SUBJECT = 500;
const MAX_MESSAGE_ID = 500;
const MAX_URL = 4000;
const MAX_AUTH_RESULTS = 2000;
const MAX_DATE_HEADER = 200;

// C0 controls plus DEL. Header values legitimately never contain these, and a
// raw NUL is unstorable in Postgres text columns.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

// Bounded gap between "view" and "online"/"browser" (not `.*`): an unbounded
// quantifier here backtracks O(n^2) against an attacker-controlled anchor
// label (label length tracks the HTML part size, which is unbounded).
const VIEW_ONLINE_LABEL = /view[^]{0,60}?(online|browser)/i;

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Strip control characters, trim, and clamp. Empty results become null so
 * callers never have to distinguish '' from "absent".
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(CONTROL_CHARS, '').trim();
  return stripped ? stripped.slice(0, max) : null;
}

/**
 * @param {{ headers?: Array<{ key: string, value: string }> }} parsed
 * @param {string} key lowercase header name
 * @returns {string|null}
 */
function headerValue(parsed, key) {
  const found = (parsed.headers || []).find((h) => h && h.key === key);
  return found && typeof found.value === 'string' ? found.value : null;
}

/**
 * Pull the `<...>` entries out of a structured list header. Splitting on the
 * angle brackets rather than on commas is what makes this safe: real
 * List-Unsubscribe values contain commas inside their query strings.
 *
 * @param {string|null} value
 * @returns {string[]}
 */
function bracketedEntries(value) {
  if (typeof value !== 'string') return [];
  const entries = [];
  const pattern = /<([^<>]*)>/g;
  let match = pattern.exec(value);
  while (match !== null) {
    const entry = match[1].replace(CONTROL_CHARS, '').trim();
    if (entry) entries.push(entry);
    match = pattern.exec(value);
  }
  return entries;
}

const isScheme = (value, scheme) => value.slice(0, scheme.length).toLowerCase() === scheme;

/**
 * @param {string|null} listUnsubscribe
 * @returns {string|null}
 */
function pickUnsubscribeUrl(listUnsubscribe) {
  const usable = bracketedEntries(listUnsubscribe).filter((e) => e.length <= MAX_URL);
  return (
    usable.find((e) => isScheme(e, 'https:')) || usable.find((e) => isScheme(e, 'mailto:')) || null
  );
}

/**
 * Decode the handful of entities that appear in real email hrefs. 52 of the 76
 * anchors in the Mailchimp fixture carry `&amp;`; storing that undecoded yields
 * a link that 404s.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#39);/gi, (entity) => {
    const key = entity.toLowerCase();
    return HTML_ENTITIES[key] !== undefined ? HTML_ENTITIES[key] : entity;
  });
}

/**
 * First anchor whose visible label reads like "view this online / in browser".
 *
 * @param {string|null} html
 * @returns {string|null}
 */
function findViewOnlineAnchor(html) {
  if (typeof html !== 'string' || !html) return null;
  // Built per call: a /g regex kept at module scope carries lastIndex between
  // messages and would silently skip the first anchors of the next email.
  const anchor = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchor.exec(html);
  while (match !== null) {
    const label = match[4]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (VIEW_ONLINE_LABEL.test(label)) {
      const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '')
        .replace(CONTROL_CHARS, '')
        .trim();
      if (isScheme(href, 'https://') && href.length <= MAX_URL) return href;
    }
    match = anchor.exec(html);
  }
  return null;
}

/**
 * @param {string|null} listPost
 * @param {string|null} html
 * @returns {string|null}
 */
function pickWebUrl(listPost, html) {
  const fromHeader = bracketedEntries(listPost).find(
    (e) => isScheme(e, 'https://') && e.length <= MAX_URL,
  );
  return fromHeader || findViewOnlineAnchor(html);
}

/**
 * Stable identity for a message. Message-ID is authoritative when the sender
 * supplies one; otherwise hash the parts of the message a resend would keep
 * identical, so a redelivery of the same issue collapses onto one row.
 *
 * @param {{ messageId: string|null, fromEmail: string|null, subject: string|null,
 *           dateHeader: string|null, html: string|null, text: string|null }} fields
 * @returns {string}
 */
function buildDedupeKey({ messageId, fromEmail, subject, dateHeader, html, text }) {
  if (messageId) return messageId;
  const body = sha256(`${html ?? ''}${text ?? ''}`);
  return sha256(`${fromEmail ?? ''}\n${subject ?? ''}\n${dateHeader ?? ''}\n${body}`);
}

/**
 * Turn raw inbound email bytes into the structured record the ingest pipeline
 * stores.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array|string} rawBuffer
 * @returns {Promise<{
 *   fromEmail: string|null, fromName: string|null, subject: string|null,
 *   html: string|null, text: string|null, messageId: string|null,
 *   dateHeader: string|null, webUrl: string|null, unsubscribeUrl: string|null,
 *   authResults: string|null, dedupeKey: string
 * }|null>} null only when the input carries no recoverable message at all.
 */
export async function parseEmail(rawBuffer) {
  let parsed;
  try {
    parsed = await PostalMime.parse(rawBuffer);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const fromEmail = cleanText(parsed.from && parsed.from.address, MAX_FROM_EMAIL);
  const fromName = cleanText(parsed.from && parsed.from.name, MAX_FROM_NAME);
  const subject = cleanText(parsed.subject, MAX_SUBJECT);
  // Bodies are passed through verbatim — including any NUL bytes. Sanitising
  // them is the storage layer's job, and stripping here would hide the input.
  const html = typeof parsed.html === 'string' && parsed.html ? parsed.html : null;
  const text = typeof parsed.text === 'string' && parsed.text ? parsed.text : null;

  // Nothing recoverable: the caller maps this to a 422.
  if (!fromEmail && !subject && !html && !text) return null;

  const messageId = cleanText(parsed.messageId, MAX_MESSAGE_ID);
  const dateHeader = cleanText(headerValue(parsed, 'date'), MAX_DATE_HEADER);
  const webUrl = pickWebUrl(headerValue(parsed, 'list-post'), html);
  const unsubscribeUrl = pickUnsubscribeUrl(headerValue(parsed, 'list-unsubscribe'));
  const authResults = cleanText(headerValue(parsed, 'authentication-results'), MAX_AUTH_RESULTS);

  return {
    fromEmail,
    fromName,
    subject,
    html,
    text,
    messageId,
    dateHeader,
    webUrl,
    unsubscribeUrl,
    authResults,
    dedupeKey: buildDedupeKey({ messageId, fromEmail, subject, dateHeader, html, text }),
  };
}
