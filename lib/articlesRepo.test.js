import { describe, it, expect, vi } from 'vitest';
import { selectHeadlines, storeIsWarm, StoreUnavailableError } from './articlesRepo.js';
import { mapFeedItems } from './feedParser.js';

const ROW = {
  id: 'a'.repeat(16), url: 'https://x.com/a', title: 'T', source_id: 'daily-star',
  source_name: 'The Daily Star', source_short_name: 'DS', source_color: '#E31E24',
  category: 'bangladesh', thumbnail: null, is_paywall: false,
  published_at: '2026-07-18T00:00:00.000Z',
};

function fakeClient(result = { data: [ROW], error: null }) {
  const calls = { in: null, eq: null, order: null, limit: null };
  const builder = {
    select: vi.fn(() => builder),
    in: vi.fn((col, vals) => { calls.in = [col, vals]; return builder; }),
    eq: vi.fn((col, val) => { calls.eq = [col, val]; return builder; }),
    order: vi.fn((col, opts) => { calls.order = [col, opts]; return builder; }),
    limit: vi.fn((n) => { calls.limit = n; return Promise.resolve(result); }),
  };
  return { client: { from: vi.fn(() => builder) }, calls, builder };
}

describe('selectHeadlines', () => {
  it('maps rows to the exact mapFeedItems headline shape (snake→camel)', async () => {
    const { client } = fakeClient();
    const [headline] = await selectHeadlines({ sourceIds: ['daily-star'] }, client);
    const src = { id: 's', name: 'n', shortName: 'sn', color: '#fff', category: 'c', paywall: false };
    const [reference] = mapFeedItems([{ title: 't', link: 'https://x.com/r', pubDate: '2026-01-01' }], src);
    expect(Object.keys(headline).sort()).toEqual(Object.keys(reference).sort());
  });
  it('passes category as a bound .eq value — PostgREST filter syntax injects nothing', async () => {
    const { client, calls } = fakeClient();
    const hostile = 'x,or(id.eq.1)';
    await selectHeadlines({ sourceIds: ['daily-star'], category: hostile }, client);
    expect(calls.eq).toEqual(['category', hostile]); // passed as a value, never string-built
  });
  it('filters non-string source ids and clamps limit to 200', async () => {
    const { client, calls } = fakeClient();
    await selectHeadlines({ sourceIds: ['ok', 42, null], limit: 9999 }, client);
    expect(calls.in).toEqual(['source_id', ['ok']]);
    expect(calls.limit).toBe(200);
  });
  it('returns [] for an empty selection without querying', async () => {
    const { client } = fakeClient();
    expect(await selectHeadlines({ sourceIds: [] }, client)).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });
  it('throws StoreUnavailableError when the client is missing or errors', async () => {
    await expect(selectHeadlines({ sourceIds: ['a'] }, null)).rejects.toBeInstanceOf(StoreUnavailableError);
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(selectHeadlines({ sourceIds: ['a'] }, client)).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});

describe('storeIsWarm', () => {
  it('true when a row exists, false when empty, false without a client, false on error', async () => {
    const warm = { from: () => ({ select: () => ({ limit: () => Promise.resolve({ data: [{ id: 'x' }], error: null }) }) }) };
    const cold = { from: () => ({ select: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) };
    const broken = { from: () => ({ select: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'x' } }) }) }) };
    expect(await storeIsWarm(warm)).toBe(true);
    expect(await storeIsWarm(cold)).toBe(false);
    expect(await storeIsWarm(null)).toBe(false);
    expect(await storeIsWarm(broken)).toBe(false);
  });
});
