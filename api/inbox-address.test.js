import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/authVerify.js', () => {
  class AuthError extends Error {
    constructor(message) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireUser: vi.fn(), AuthError };
});
vi.mock('../lib/rateLimit.js', () => ({
  checkRateLimit: vi.fn(),
}));
vi.mock('../lib/inboxRepo.js', () => ({
  getAddressRow: vi.fn(),
  ensureAddress: vi.fn(),
  rotateSlug: vi.fn(),
  disableSlug: vi.fn(),
  quotaSnapshot: vi.fn(),
}));

import { requireUser, AuthError } from '../lib/authVerify.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { getAddressRow, ensureAddress, rotateSlug, disableSlug, quotaSnapshot } from '../lib/inboxRepo.js';
import { INGEST_DOMAIN } from '../lib/inboxConfig.js';
import handler from './inbox-address.mjs';

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}

const USER_ID = 'user-1';

function req(method, { body } = {}) {
  return {
    method,
    url: '/api/inbox-address',
    headers: { host: 'test', 'x-forwarded-for': '10.1.1.1', authorization: 'Bearer good-token' },
    body,
  };
}

function makeRow(overrides = {}) {
  return {
    id: 'addr-1',
    userId: USER_ID,
    slug: 'abc123',
    overQuotaSince: null,
    deferredCount: 0,
    lastDeferredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Rate-limit keys denied for the current test — everything else resolves
// allowed so tests that don't care about limiting don't have to know about it.
let deniedRateLimitKeys;

beforeEach(() => {
  deniedRateLimitKeys = new Set();
  vi.mocked(requireUser).mockReset().mockResolvedValue({ userId: USER_ID });
  vi.mocked(checkRateLimit).mockReset().mockImplementation(async (key) => ({
    allowed: !deniedRateLimitKeys.has(key),
  }));
  vi.mocked(getAddressRow).mockReset();
  vi.mocked(ensureAddress).mockReset();
  vi.mocked(rotateSlug).mockReset();
  vi.mocked(disableSlug).mockReset().mockResolvedValue(undefined);
  vi.mocked(quotaSnapshot).mockReset().mockResolvedValue({ messageCount: 0, bytesUsed: 0 });
});

describe('auth guard', () => {
  it.each(['GET', 'POST', 'DELETE'])('%s → 401 when requireUser throws AuthError', async (method) => {
    vi.mocked(requireUser).mockRejectedValue(new AuthError('no token'));
    const res = fakeRes();
    await handler(req(method, { body: {} }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('a non-AuthError from requireUser → 500', async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error('boom'));
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error' });
  });
});

describe('rate limiting', () => {
  it('per-IP limiter (inbox-addr:${ip}) denies → 429 before requireUser is ever called', async () => {
    deniedRateLimitKeys.add('inbox-addr:10.1.1.1');
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
    expect(requireUser).not.toHaveBeenCalled();
  });

  it('per-user limiter (inbox-addr-user:${userId}) denies with the IP limiter allowing → 429 before any repo call runs', async () => {
    deniedRateLimitKeys.add(`inbox-addr-user:${USER_ID}`);
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
    expect(getAddressRow).not.toHaveBeenCalled();
  });
});

describe('GET /api/inbox-address', () => {
  it('no row → default shape, without ever calling quotaSnapshot', async () => {
    vi.mocked(getAddressRow).mockResolvedValue(null);
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      address: null, bytesUsed: 0, messageCount: 0, overQuotaSince: null, deferredCount: 0,
    });
    expect(quotaSnapshot).not.toHaveBeenCalled();
  });

  it('row with a live slug → composes slug@INGEST_DOMAIN and reports the row + quotaSnapshot figures', async () => {
    vi.mocked(getAddressRow).mockResolvedValue(
      makeRow({ slug: 'abc123', overQuotaSince: '2026-07-01T00:00:00.000Z', deferredCount: 4 })
    );
    vi.mocked(quotaSnapshot).mockResolvedValue({ messageCount: 12, bytesUsed: 4096 });
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      address: `abc123@${INGEST_DOMAIN}`,
      bytesUsed: 4096,
      messageCount: 12,
      overQuotaSince: '2026-07-01T00:00:00.000Z',
      deferredCount: 4,
    });
    expect(quotaSnapshot).toHaveBeenCalledWith(USER_ID);
  });

  it('row with a disabled (null) slug → address null but quota figures stay intact (row-preserving)', async () => {
    vi.mocked(getAddressRow).mockResolvedValue(
      makeRow({ slug: null, overQuotaSince: null, deferredCount: 2 })
    );
    vi.mocked(quotaSnapshot).mockResolvedValue({ messageCount: 5, bytesUsed: 1024 });
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      address: null, bytesUsed: 1024, messageCount: 5, overQuotaSince: null, deferredCount: 2,
    });
  });
});

describe('POST /api/inbox-address', () => {
  it('POST {} is idempotent: a user with a live slug gets the SAME address back via ensureAddress; rotateSlug is never called', async () => {
    vi.mocked(ensureAddress).mockResolvedValue(
      makeRow({ slug: 'existing1', overQuotaSince: null, deferredCount: 0 })
    );
    vi.mocked(quotaSnapshot).mockResolvedValue({ messageCount: 3, bytesUsed: 200 });
    const res = fakeRes();
    await handler(req('POST', { body: {} }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      address: `existing1@${INGEST_DOMAIN}`, bytesUsed: 200, messageCount: 3, overQuotaSince: null, deferredCount: 0,
    });
    expect(ensureAddress).toHaveBeenCalledWith(USER_ID);
    expect(rotateSlug).not.toHaveBeenCalled();
  });

  it('POST with an unparsable JSON string body → 400 Invalid JSON, no repo call', async () => {
    const res = fakeRes();
    await handler(req('POST', { body: '{not valid json' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON' });
    expect(ensureAddress).not.toHaveBeenCalled();
    expect(rotateSlug).not.toHaveBeenCalled();
  });

  it('POST { regenerate: true } calls rotateSlug (not ensureAddress) and returns the new address', async () => {
    vi.mocked(rotateSlug).mockResolvedValue(
      makeRow({ slug: 'freshslug', overQuotaSince: null, deferredCount: 0 })
    );
    vi.mocked(quotaSnapshot).mockResolvedValue({ messageCount: 3, bytesUsed: 200 });
    const res = fakeRes();
    await handler(req('POST', { body: { regenerate: true } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      address: `freshslug@${INGEST_DOMAIN}`, bytesUsed: 200, messageCount: 3, overQuotaSince: null, deferredCount: 0,
    });
    expect(rotateSlug).toHaveBeenCalledWith(USER_ID);
    expect(ensureAddress).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/inbox-address', () => {
  it('calls disableSlug and returns address null with quota figures intact', async () => {
    vi.mocked(getAddressRow).mockResolvedValue(
      makeRow({ slug: null, overQuotaSince: '2026-06-01T00:00:00.000Z', deferredCount: 7 })
    );
    vi.mocked(quotaSnapshot).mockResolvedValue({ messageCount: 9, bytesUsed: 8192 });
    const res = fakeRes();
    await handler(req('DELETE'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      address: null, bytesUsed: 8192, messageCount: 9, overQuotaSince: '2026-06-01T00:00:00.000Z', deferredCount: 7,
    });
    expect(disableSlug).toHaveBeenCalledWith(USER_ID);
  });
});

describe('method dispatch', () => {
  it('PATCH → 405, no repo call touched', async () => {
    const res = fakeRes();
    await handler(req('PATCH', { body: {} }), res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(getAddressRow).not.toHaveBeenCalled();
    expect(ensureAddress).not.toHaveBeenCalled();
    expect(rotateSlug).not.toHaveBeenCalled();
    expect(disableSlug).not.toHaveBeenCalled();
  });
});
