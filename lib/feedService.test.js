import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getHeadlinesForSources, getCatalogHeadlines, resetFallbackForTests } from './feedService.js';
import { buildCatalogIndex } from './catalogIndex.js';

const STORE_H = { id: 'a'.repeat(16), title: 'S', url: 'https://x.com/s', sourceId: 'daily-star', sourceName: 'DS', sourceShortName: 'DS', sourceColor: '#E31E24', category: 'bangladesh', thumbnail: null, publishedAt: '2026-07-18T05:00:00.000Z', isPaywall: false };
const LIVE_H = { ...STORE_H, id: 'b'.repeat(16), title: 'L', sourceId: 'custom-1', publishedAt: '2026-07-18T06:00:00.000Z' };
const CATALOG_SRC = { id: 'daily-star', feedUrl: 'https://evil.example/hijack.xml' };
const CUSTOM_SRC = { id: 'custom-1', name: 'C', feedUrl: 'https://c.example/rss' };

const deps = () => ({
  storeIsWarm: vi.fn().mockResolvedValue(true),
  selectHeadlines: vi.fn().mockResolvedValue([STORE_H]),
  fetchFeeds: vi.fn().mockResolvedValue({ headlines: [LIVE_H], stats: { total: 1, succeeded: 1, failed: 0 } }),
});

beforeEach(() => resetFallbackForTests());

describe('getHeadlinesForSources (POST branch)', () => {
  it('serves catalog from the store keyed by server-side id — client feedUrl ignored', async () => {
    const d = deps();
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([STORE_H]);
    expect(d.selectHeadlines).toHaveBeenCalledWith({ sourceIds: ['daily-star'], category: null, limit: 200 });
    expect(d.fetchFeeds).not.toHaveBeenCalled(); // the hijack feedUrl never reaches a fetch
    expect(r.feedStats.served).toBe('store');
  });
  it('merges store catalog + live custom, sorted by publishedAt desc', async () => {
    const d = deps();
    const r = await getHeadlinesForSources([CATALOG_SRC, CUSTOM_SRC], { deps: d });
    expect(r.headlines.map((h) => h.title)).toEqual(['L', 'S']);
    expect(d.fetchFeeds).toHaveBeenCalledTimes(1);
    expect(d.fetchFeeds.mock.calls[0][0]).toEqual([CUSTOM_SRC]);
  });
  it('warm store + empty filtered slice returns empty WITHOUT live fallback (cold ≠ empty)', async () => {
    const d = { ...deps(), selectHeadlines: vi.fn().mockResolvedValue([]) };
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([]);
    expect(d.fetchFeeds).not.toHaveBeenCalled();
  });
  it('globally-cold store falls back live for the SELECTED catalog sources only, single-flight cached', async () => {
    const d = { ...deps(), storeIsWarm: vi.fn().mockResolvedValue(false) };
    const r1 = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    const r2 = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r1.feedStats.served).toBe('fallback');
    expect(r1.headlines).toEqual([LIVE_H]);
    expect(r2.headlines).toEqual([LIVE_H]);
    expect(d.fetchFeeds).toHaveBeenCalledTimes(1); // second call hit the cached slot
    const [selected] = d.fetchFeeds.mock.calls[0];
    expect(selected.map((s) => s.id)).toEqual(['daily-star']);
    expect(selected[0].feedUrl).toBe('https://www.thedailystar.net/rss.xml'); // server catalog, not client value
  });
  it('store read error also falls back live', async () => {
    const d = { ...deps(), storeIsWarm: vi.fn().mockRejectedValue(new Error('db down')) };
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.feedStats.served).toBe('fallback');
    expect(r.headlines).toEqual([LIVE_H]);
  });
  it('503 only when nothing was served and live fetching failed', async () => {
    const d = {
      storeIsWarm: vi.fn().mockResolvedValue(false),
      selectHeadlines: vi.fn(),
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: [], stats: { total: 1, succeeded: 0, failed: 1 } }),
    };
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.status).toBe(503);
  });
  it('SSRF: a custom source pointing at link-local metadata is rejected by the real safeFetch chain', async () => {
    const ssrf = { id: 'evil', name: 'E', feedUrl: 'http://169.254.169.254/latest/meta-data/' };
    const r = await getHeadlinesForSources([ssrf], {}); // real deps; private IP rejects pre-network
    expect(r.status).toBe(503);
    expect(r.feedStats).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
  }, 15000);
});

describe('getCatalogHeadlines (GET branch)', () => {
  it('serves the category-filtered catalog from the store', async () => {
    const d = deps();
    const r = await getCatalogHeadlines({ category: 'bangladesh', deps: d });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([STORE_H]);
    const arg = d.selectHeadlines.mock.calls[0][0];
    expect(arg.category).toBe('bangladesh');
    expect(arg.sourceIds).toEqual(['daily-star', 'business-standard-bd', 'bbc-bangla', 'prothom-alo-en']);
  });
  it('unknown source filter returns empty 200', async () => {
    const r = await getCatalogHeadlines({ source: 'not-a-source', deps: deps() });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([]);
  });
});

describe('alias resolution (2D spec §5.1)', () => {
  const CATALOG = { sources: [{ id: 'new-slug', name: 'A', category: 'macro', aliases: ['old-slug'] }] };
  const IDX = buildCatalogIndex(CATALOG);

  function makeDeps(overrides = {}) {
    return {
      catalogIndex: IDX,
      catalog: CATALOG,
      storeIsWarm: async () => true,
      selectHeadlines: vi.fn(async () => []),
      fetchFeeds: vi.fn(async () => ({ headlines: [], stats: { total: 1, succeeded: 1, failed: 0 } })),
      ...overrides,
    };
  }

  it('POST: an aliased id resolves to canonical before the store query', async () => {
    const deps = makeDeps();
    await getHeadlinesForSources([{ id: 'old-slug' }], { deps });
    expect(deps.selectHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['new-slug'] })
    );
    expect(deps.fetchFeeds).not.toHaveBeenCalled();
  });

  it('POST: canonical and aliased ids do not double-query', async () => {
    const deps = makeDeps();
    await getHeadlinesForSources([{ id: 'old-slug' }, { id: 'new-slug' }], { deps });
    expect(deps.selectHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['new-slug'] })
    );
  });

  it('POST: an unknown id still routes to the live custom path', async () => {
    const deps = makeDeps();
    await getHeadlinesForSources([{ id: 'mystery', feedUrl: 'https://x.example/f' }], { deps });
    expect(deps.fetchFeeds).toHaveBeenCalled();
  });

  it('GET: ?source= through an alias serves the canonical source', async () => {
    const deps = makeDeps();
    await getCatalogHeadlines({ source: 'old-slug', deps });
    expect(deps.selectHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['new-slug'] })
    );
  });
});
