import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/feedService.js', () => ({
  getHeadlinesForSources: vi.fn(),
  getCatalogHeadlines: vi.fn(),
}));
vi.mock('../lib/authVerify.js', () => {
  class AuthError extends Error {
    constructor(message) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireUser: vi.fn(), AuthError };
});
import { getHeadlinesForSources, getCatalogHeadlines } from '../lib/feedService.js';
import { requireUser, AuthError } from '../lib/authVerify.js';
import handler from './feeds.mjs';

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}
const SRC = { id: 'daily-star', feedUrl: 'https://x.example/f.xml' };
function post(body, ip = '10.9.9.9', authHeader) {
  const headers = { host: 'test', 'x-forwarded-for': ip };
  if (authHeader) headers.authorization = authHeader;
  return { method: 'POST', url: '/api/feeds', headers, body };
}

beforeEach(() => {
  vi.mocked(getHeadlinesForSources).mockReset().mockResolvedValue({ headlines: [], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
  vi.mocked(getCatalogHeadlines).mockReset().mockResolvedValue({ headlines: [], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
  vi.mocked(requireUser).mockReset().mockResolvedValue({ userId: 'default-user' });
});

describe('guard chain preserved (spec §5.2)', () => {
  it('OPTIONS → 204', async () => {
    const res = fakeRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    expect(res.statusCode).toBe(204);
  });
  it('400 on missing/empty sources and invalid JSON', async () => {
    let res = fakeRes();
    await handler(post({}), res);
    expect(res.statusCode).toBe(400);
    res = fakeRes();
    await handler(post('{not json', '10.9.9.8'), res);
    expect(res.statusCode).toBe(400);
  });
  it('400 past the 30-source cap', async () => {
    const res = fakeRes();
    await handler(post({ sources: Array.from({ length: 31 }, (_, i) => ({ id: `s${i}` })) }, '10.9.9.7'), res);
    expect(res.statusCode).toBe(400);
    expect(getHeadlinesForSources).not.toHaveBeenCalled();
  });
  it('429 past 60 requests/60s from one IP', async () => {
    let last;
    for (let i = 0; i < 61; i++) {
      last = fakeRes();
      await handler(post({ sources: [SRC] }, '10.1.2.3'), last);
    }
    expect(last.statusCode).toBe(429);
  });
});

describe('service wiring', () => {
  it('POST returns the contract shape and passes sources + category through', async () => {
    vi.mocked(getHeadlinesForSources).mockResolvedValue({ headlines: [{ id: 'x' }], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
    const res = fakeRes();
    await handler(post({ sources: [SRC], category: 'tech' }, '10.9.9.6'), res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['cached', 'feedStats', 'fetchedAt', 'headlines']);
    expect(getHeadlinesForSources).toHaveBeenCalledWith([SRC], { category: 'tech' });
  });
  it('POST surfaces a 503 from the service as 503 with empty headlines', async () => {
    vi.mocked(getHeadlinesForSources).mockResolvedValue({ headlines: [], feedStats: { total: 1, succeeded: 0, failed: 1, served: 'error' }, status: 503 });
    const res = fakeRes();
    await handler(post({ sources: [SRC] }, '10.9.9.5'), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.headlines).toEqual([]);
  });
  it('GET routes through getCatalogHeadlines with query params', async () => {
    const res = fakeRes();
    await handler({ method: 'GET', url: '/api/feeds?category=tech&source=techcrunch', headers: { host: 'test', 'x-forwarded-for': '10.9.9.4' } }, res);
    expect(res.statusCode).toBe(200);
    expect(getCatalogHeadlines).toHaveBeenCalledWith({ category: 'tech', source: 'techcrunch' });
  });
});

describe('premium merge (2E Task 8)', () => {
  it('(a) sources: [] + premiumIds + valid token → 200, validation relaxed, premium merged in', async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: 'user-a' });
    vi.mocked(getHeadlinesForSources).mockResolvedValue({
      headlines: [{ id: 'p1', isPremium: true }],
      feedStats: { total: 1, succeeded: 1, failed: 0, served: 'none' },
      status: 200,
      premiumStatus: [{ id: 'x', ok: true }],
    });
    const res = fakeRes();
    await handler(post({ sources: [], premiumIds: ['x'] }, '10.9.9.20', 'Bearer good-token'), res);
    expect(res.statusCode).toBe(200);
    expect(getHeadlinesForSources).toHaveBeenCalledWith([], { category: null, premium: { userId: 'user-a', ids: ['x'] } });
    expect(res.body.premiumStatus).toEqual([{ id: 'x', ok: true }]);
    expect(res.body.premiumAuthFailed).toBeUndefined();
  });

  it('(b) sources: [] + no premiumIds → 400 (existing rule holds)', async () => {
    const res = fakeRes();
    await handler(post({ sources: [] }, '10.9.9.19'), res);
    expect(res.statusCode).toBe(400);
    expect(getHeadlinesForSources).not.toHaveBeenCalled();
  });

  it('(c) invalid token + premiumIds → 200 with premiumAuthFailed: true, catalog still served, no premium in the service call', async () => {
    vi.mocked(requireUser).mockRejectedValue(new AuthError('bad token'));
    vi.mocked(getHeadlinesForSources).mockResolvedValue({
      headlines: [{ id: 'catalog-1' }],
      feedStats: { total: 1, succeeded: 1, failed: 0, served: 'store' },
      status: 200,
      premiumStatus: [],
    });
    const res = fakeRes();
    await handler(post({ sources: [SRC], premiumIds: ['x'] }, '10.9.9.18', 'Bearer bad-token'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.premiumAuthFailed).toBe(true);
    expect(res.body.headlines).toEqual([{ id: 'catalog-1' }]);
    expect(getHeadlinesForSources).toHaveBeenCalledWith([SRC], { category: null });
  });

  it('(d) premiumIds longer than 10 → not a 400; full list forwarded for the real resolvePremiumSources to slice (see lib/feedService.test.js)', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `id-${i}`);
    vi.mocked(requireUser).mockResolvedValue({ userId: 'user-d' });
    vi.mocked(getHeadlinesForSources).mockResolvedValue({
      headlines: [], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'none' }, status: 200, premiumStatus: [],
    });
    const res = fakeRes();
    await handler(post({ sources: [], premiumIds: ids }, '10.9.9.17', 'Bearer good-token'), res);
    expect(res.statusCode).not.toBe(400);
    expect(getHeadlinesForSources).toHaveBeenCalledWith([], { category: null, premium: { userId: 'user-d', ids } });
  });

  it('(e) per-user premium limiter (premium-fetch:${userId} 30/60s) exceeded → premium omitted, catalog still served, never a 429 for the whole feed', async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: 'user-e-limit' });
    vi.mocked(getHeadlinesForSources).mockResolvedValue({
      headlines: [{ id: 'catalog-1' }],
      feedStats: { total: 1, succeeded: 1, failed: 0, served: 'store' },
      status: 200,
      premiumStatus: [],
    });
    let last;
    for (let i = 0; i < 31; i++) {
      last = fakeRes();
      await handler(post({ sources: [SRC], premiumIds: ['x'] }, '10.9.9.16', 'Bearer good-token'), last);
    }
    expect(last.statusCode).toBe(200);
    expect(last.body.premiumStatus).toEqual([]);
    expect(last.body.premiumAuthFailed).toBeUndefined();
    expect(getHeadlinesForSources).toHaveBeenLastCalledWith([SRC], { category: null });
  });

  it('(f) premium-only all-fail service response → 200 with premiumStatus relayed (catalog-caused 503s handled separately, untouched)', async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: 'user-f' });
    vi.mocked(getHeadlinesForSources).mockResolvedValue({
      headlines: [],
      feedStats: { total: 2, succeeded: 0, failed: 2, served: 'none' },
      status: 200,
      premiumStatus: [
        { id: 'premium-feed-1', ok: false, reason: 'unavailable' },
        { id: 'premium-feed-2', ok: false, reason: 'rejected' },
      ],
    });
    const res = fakeRes();
    await handler(post({ sources: [], premiumIds: ['premium-feed-1', 'premium-feed-2'] }, '10.9.9.15', 'Bearer good-token'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.headlines).toEqual([]);
    expect(res.body.premiumStatus).toEqual([
      { id: 'premium-feed-1', ok: false, reason: 'unavailable' },
      { id: 'premium-feed-2', ok: false, reason: 'rejected' },
    ]);
  });
});
