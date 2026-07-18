// Single source of truth for article identity (2B spec §5.3, decision D4).
// Pure JS — no node:crypto — so server (feedParser, extractor, poller) and
// browser (IndexedDB re-key) compute byte-identical ids.

const TRACKING_PARAM =
  /^(utm_.*|at_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|_hsenc|_hsmi|s_kwcid|yclid|cmpid|ito)$/;

export function canonicalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.protocol = 'https:';
  url.hash = '';
  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  url.hostname = host;
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k.toLowerCase()));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

// cyrb64 — 64-bit non-crypto hash. This is a dedup key, not a security token.
function hash64hex(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// Total: never throws. Null only when the item has no usable key — callers
// drop those items. Fallback order link → guid → title keeps link-less
// items distinct (spec Finding 4).
export function articleId(input) {
  if (input == null) return null;
  const item = typeof input === 'string' ? { link: input } : input;
  const link = typeof item.link === 'string' ? item.link : null;
  const guid = typeof item.guid === 'string' && item.guid.trim() !== '' ? item.guid.trim() : null;
  const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : null;
  const key = canonicalizeUrl(link) ?? guid ?? title;
  if (key == null) return null;
  return hash64hex(key);
}
