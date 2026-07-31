import { timingSafeEqual } from 'node:crypto';

// Fail-closed ingest auth (mirrors lib/cronAuth.js): unset primary secret
// rejects BEFORE any compare; length-guarded timingSafeEqual; the header
// and secrets are never logged. INGEST_SECRET_PREV is accepted only when
// INGEST_SECRET is set, so zero-downtime rotation never becomes a second
// fail-open path.
function matches(header, secret) {
  const expected = Buffer.from(secret);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function verifyIngestSecret(req) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return false;
  const header = req?.headers?.['x-ingest-secret'];
  if (typeof header !== 'string') return false;
  if (matches(header, secret)) return true;
  const prevSecret = process.env.INGEST_SECRET_PREV;
  if (!prevSecret) return false;
  return matches(header, prevSecret);
}
