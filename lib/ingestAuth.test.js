import { describe, it, expect, beforeEach } from 'vitest';
import { verifyIngestSecret } from './ingestAuth.js';

describe('verifyIngestSecret', () => {
  beforeEach(() => {
    delete process.env.INGEST_SECRET;
    delete process.env.INGEST_SECRET_PREV;
  });
  const req = (v) => ({ headers: v === undefined ? {} : { 'x-ingest-secret': v } });

  it('rejects when INGEST_SECRET is unset (fail-closed), even on empty match', () => {
    expect(verifyIngestSecret(req(''))).toBe(false);
    expect(verifyIngestSecret(req(undefined))).toBe(false);
  });
  it('accepts the current secret, rejects wrong/absent/prefix values', () => {
    process.env.INGEST_SECRET = 's3cret-value';
    expect(verifyIngestSecret(req('s3cret-value'))).toBe(true);
    expect(verifyIngestSecret(req('s3cret-valu'))).toBe(false);
    expect(verifyIngestSecret(req('s3cret-value2'))).toBe(false);
    expect(verifyIngestSecret(req(undefined))).toBe(false);
  });
  it('accepts INGEST_SECRET_PREV during rotation, only when primary is set', () => {
    process.env.INGEST_SECRET = 'new';
    process.env.INGEST_SECRET_PREV = 'old';
    expect(verifyIngestSecret(req('old'))).toBe(true);
    expect(verifyIngestSecret(req('new'))).toBe(true);
    delete process.env.INGEST_SECRET;
    expect(verifyIngestSecret(req('old'))).toBe(false);
  });
  it('never throws on non-string header', () => {
    process.env.INGEST_SECRET = 'x';
    expect(verifyIngestSecret({ headers: { 'x-ingest-secret': 42 } })).toBe(false);
    expect(verifyIngestSecret({})).toBe(false);
  });
});
