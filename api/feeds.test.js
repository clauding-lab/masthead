import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/feedService.js', () => ({
  getHeadlinesForSources: vi.fn(),
  getCatalogHeadlines: vi.fn(),
}));
import { getHeadlinesForSources, getCatalogHeadlines } from '../lib/feedService.js';
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
function post(body, ip = '10.9.9.9') {
  return { method: 'POST', url: '/api/feeds', headers: { host: 'test', 'x-forwarded-for': ip }, body };
}

beforeEach(() => {
  vi.mocked(getHeadlinesForSources).mockReset().mockResolvedValue({ headlines: [], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
  vi.mocked(getCatalogHeadlines).mockReset().mockResolvedValue({ headlines: [], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
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
