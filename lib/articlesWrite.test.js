import { describe, it, expect, vi } from 'vitest';
import { headlineToRow, upsertArticles, prune } from './articlesWrite.js';

const H = (over = {}) => ({
  id: 'f'.repeat(16), url: 'https://x.com/a', title: 'T', sourceId: 'daily-star',
  sourceName: 'The Daily Star', sourceShortName: 'DS', sourceColor: '#E31E24',
  category: 'bangladesh', thumbnail: null, publishedAt: '2026-07-18T00:00:00.000Z',
  isPaywall: false, ...over,
});

function fakeAdmin(result = { error: null, count: 3 }) {
  const calls = {};
  const client = {
    from: vi.fn(() => ({
      upsert: vi.fn((rows, opts) => { calls.upsert = { rows, opts }; return Promise.resolve(result); }),
      delete: vi.fn((opts) => { calls.deleteOpts = opts; return {
        lt: vi.fn((col, val) => { calls.lt = [col, val]; return Promise.resolve(result); }),
      }; }),
    })),
  };
  return { client, calls };
}

describe('headlineToRow', () => {
  it('maps camelCase to snake_case and OMITS first_seen_at (never reset on upsert)', () => {
    const row = headlineToRow(H());
    expect(row.source_id).toBe('daily-star');
    expect(row.is_paywall).toBe(false);
    expect(row.published_at).toBe('2026-07-18T00:00:00.000Z');
    expect('first_seen_at' in row).toBe(false);
    expect(typeof row.updated_at).toBe('string');
  });
});

describe('upsertArticles — the CRITICAL batch-dedupe', () => {
  it('two headlines sharing (source_id,id) in ONE batch upsert as one row, no throw', async () => {
    const { client, calls } = fakeAdmin();
    const n = await upsertArticles([H(), H({ title: 'later wins' })], client);
    expect(n).toBe(1);
    expect(calls.upsert.rows).toHaveLength(1);
    expect(calls.upsert.rows[0].title).toBe('later wins');
    expect(calls.upsert.opts).toEqual({ onConflict: 'source_id,id' });
  });
  it('cross-source same id → two rows preserved', async () => {
    const { client, calls } = fakeAdmin();
    const n = await upsertArticles([H(), H({ sourceId: 'hacker-news' })], client);
    expect(n).toBe(2);
    expect(calls.upsert.rows).toHaveLength(2);
  });
  it('skips id-less, url-less, and non-http(s) headlines and returns 0 for an empty batch without calling the DB', async () => {
    const { client } = fakeAdmin();
    expect(await upsertArticles([H({ id: null }), H({ url: '' }), H({ url: 'javascript:alert(1)' })], client)).toBe(0);
    expect(client.from).not.toHaveBeenCalled();
  });
  it('throws loudly on a DB error', async () => {
    const { client } = fakeAdmin({ error: { message: 'nope' } });
    await expect(upsertArticles([H()], client)).rejects.toThrow(/upsert failed/);
  });
});

describe('prune', () => {
  it('deletes rows older than maxAgeDays by first_seen_at and returns the count', async () => {
    const { client, calls } = fakeAdmin({ error: null, count: 7 });
    const n = await prune({ maxAgeDays: 14 }, client);
    expect(n).toBe(7);
    expect(calls.deleteOpts).toEqual({ count: 'exact' });
    expect(calls.lt[0]).toBe('first_seen_at');
    const cutoff = new Date(calls.lt[1]).getTime();
    const expected = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
  });
});
