// lib/premiumRedact.js
// Token redaction for premium feed data (spec §4.3 rule 1): subscriber feeds
// re-embed the registered URL's token in item links and body footers; every
// occurrence of a secret component must be stripped server-side before any
// response. Heuristics: query values >= 8 chars; path segments >= 16 chars of
// token-shaped characters (no dots — filenames are not tokens).
const MIN_QUERY_VALUE = 8;
const MIN_PATH_SEGMENT = 16;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;
const REPLACEMENT = 'redacted';

export function secretParts(feedUrl) {
  let url;
  try {
    url = new URL(feedUrl);
  } catch {
    return [];
  }
  const parts = new Set();
  for (const [, value] of url.searchParams) {
    if (value.length >= MIN_QUERY_VALUE) parts.add(value);
  }
  for (const segment of url.pathname.split('/')) {
    if (segment.length >= MIN_PATH_SEGMENT && TOKEN_SHAPE.test(segment)) parts.add(segment);
  }
  return [...parts];
}

export function redactString(text, parts) {
  if (typeof text !== 'string' || parts.length === 0) return text;
  return parts.reduce((acc, part) => acc.split(part).join(REPLACEMENT), text);
}

export function redactContentHtml(html, parts) {
  if (typeof html !== 'string' || parts.length === 0) return html;
  // Neutralize token-bearing hrefs first (keep anchor text), then sweep bare occurrences.
  const withoutHrefs = html.replace(/\shref="([^"]*)"/gi, (match, href) =>
    parts.some((p) => href.includes(p)) ? '' : match
  );
  return redactString(withoutHrefs, parts);
}
