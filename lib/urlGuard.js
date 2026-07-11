// SSRF guard for all server-side fetches of caller-supplied URLs.
// Residual risk (accepted): DNS may re-resolve differently between the
// check and the fetch (rebinding); IP pinning is out of scope this phase.
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export class UrlGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlGuardError';
  }
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const BLOCKED_HOST_SUFFIXES = ['.internal', '.local'];

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice('::ffff:'.length));
    return false;
  }
  return true;
}

export async function assertPublicUrl(urlString, { lookup = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new UrlGuardError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlGuardError('Only http and https URLs are allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new UrlGuardError('Host not allowed');
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new UrlGuardError('Address not allowed');
    return url;
  }
  let address;
  try {
    ({ address } = await lookup(hostname));
  } catch {
    throw new UrlGuardError('Could not resolve host');
  }
  if (isPrivateAddress(address)) throw new UrlGuardError('Address not allowed');
  return url;
}

export async function readBodyCapped(response, maxBytes = DEFAULT_MAX_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new UrlGuardError('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function safeFetch(urlString, options = {}) {
  const {
    headers = {},
    timeoutMs = 10000,
    maxRedirects = 3,
    maxBytes = DEFAULT_MAX_BYTES,
    lookup,
  } = options;
  const guardOpts = lookup ? { lookup } : {};
  let current = (await assertPublicUrl(urlString, guardOpts)).href;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new UrlGuardError('Redirect without location');
      current = (await assertPublicUrl(new URL(location, current).href, guardOpts)).href;
      continue;
    }
    return {
      response,
      finalUrl: current,
      text: () => readBodyCapped(response, maxBytes),
    };
  }
  throw new UrlGuardError('Too many redirects');
}
