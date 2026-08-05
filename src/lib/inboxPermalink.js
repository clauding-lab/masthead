// src/lib/inboxPermalink.js — mints and recognises the URL Masthead stores
// for a saved inbox message (spec §7.3: `id = articleId(permalink)`, and
// `savedVia` does not survive a cloud round-trip since `localFromSavedRow`
// hardcodes 'sync' — so `isInboxPermalink` is the durable half of
// `isInboxRecord`'s guard, checked against the stored `url`).
//
// The regex is matched against the URL's PATH ONLY, never the full href —
// that is what makes rejection of a query-string smuggling attempt
// (`https://x.test/a?u=/inbox/message/<uuid>`) actually work: the regex
// itself has no `^` anchor, so testing it against a raw href would still
// match that string (it legitimately ends in `/inbox/message/<uuid>`).
// Parsing the URL and testing only `pathname` removes the query string from
// consideration entirely. End-anchoring (`$`) plus a strict UUID-shaped
// final path segment is also what keeps this origin-INDEPENDENT: any host
// works, including a future Phase-4 domain, as long as the path matches.
//
// Deliberately prefix-tolerant (no `^` anchor): this predicate is the
// durable half of `isInboxRecord`'s extractor ban (Task 17) and must keep
// matching if the app is ever served under a base path. A false positive
// here just re-checks a record that wasn't actually inbox-sourced (safe); a
// false negative would let an inbox record slip past the extractor ban
// (unsafe). Tightening this regex narrows the safe side of that tradeoff.
const PERMALINK_PATH_RE =
  /\/inbox\/message\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} id
 * @returns {string}
 */
export function inboxPermalink(id) {
  return `${window.location.origin}/inbox/message/${id}`;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isInboxPermalink(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Scheme gate: without this, javascript:/data:/file: URLs whose opaque
  // payload happens to end in a valid-looking path would still pass the
  // path check below (new URL() still parses a pathname off them).
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return PERMALINK_PATH_RE.test(parsed.pathname);
}
