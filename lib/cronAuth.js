import { timingSafeEqual } from 'node:crypto';

// Fail-closed cron auth (spec §5.1 step 1): unset secret rejects BEFORE any
// compare (closes "Bearer undefined"); length-guarded timingSafeEqual; the
// Authorization header and the secret are never logged.
export function verifyCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
