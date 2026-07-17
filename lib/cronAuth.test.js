import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyCronAuth } from './cronAuth.js';

const REQ = (auth) => ({ headers: auth === undefined ? {} : { authorization: auth } });

describe('verifyCronAuth (fail-closed, spec §5.1 step 1)', () => {
  const saved = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 's3cret-value-123'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('rejects when CRON_SECRET is unset — closes the "Bearer undefined" bypass', () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronAuth(REQ('Bearer undefined'))).toBe(false);
  });
  it('rejects a missing, malformed, wrong-length, or wrong same-length header', () => {
    expect(verifyCronAuth(REQ(undefined))).toBe(false);
    expect(verifyCronAuth(REQ('s3cret-value-123'))).toBe(false);
    expect(verifyCronAuth(REQ('Bearer nope'))).toBe(false);
    expect(verifyCronAuth(REQ('Bearer s3cret-value-124'))).toBe(false);
  });
  it('accepts the exact bearer token', () => {
    expect(verifyCronAuth(REQ('Bearer s3cret-value-123'))).toBe(true);
  });
});
