// lib/hostHint.js
// Masked identity for premium feeds (spec §3.1): registrable domain only —
// some subscriber schemes embed reader tokens in subdomain labels, so the
// full hostname is not safe to show or log.
import { getDomain } from 'tldts';

export function registrableDomain(urlString) {
  const { hostname } = new URL(urlString);
  return getDomain(hostname) || hostname;
}
