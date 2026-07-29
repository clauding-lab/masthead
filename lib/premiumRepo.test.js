import { describe, it, expect, vi } from 'vitest';
import {
  listFeeds, getOwnedFeedsWithUrls, countFeeds, findByUrl,
  insertFeed, updateFeedMeta, deleteFeed,
  PremiumCapError, PremiumDuplicateError,
} from './premiumRepo.js';

// Chained Supabase query-builder mock, mirroring lib/articlesWrite.test.js's
// fakeAdmin style but extended for premiumRepo's multi-.eq()/.in()/.order()
// chains. Every chain method returns the same builder; the builder is also
// thenable so `await ...eq(...)` resolves without an explicit terminal call,
// and .single()/.maybeSingle() resolve explicitly for chains that call them.
function fakeClient(result = { data: null, error: null }) {
  const calls = { eq: [] };
  const builder = {
    select: vi.fn((cols, opts) => { calls.select = { cols, opts }; return builder; }),
    insert: vi.fn((row) => { calls.insert = row; return builder; }),
    update: vi.fn((patch) => { calls.update = patch; return builder; }),
    delete: vi.fn(() => { calls.delete = true; return builder; }),
    eq: vi.fn((col, val) => { calls.eq.push([col, val]); return builder; }),
    in: vi.fn((col, vals) => { calls.in = [col, vals]; return builder; }),
    order: vi.fn((col, opts) => { calls.order = [col, opts]; return builder; }),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    single: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  const client = { from: vi.fn((table) => { calls.table = table; return builder; }) };
  return { client, calls };
}

const dbRow = (over = {}) => ({
  id: 'abc123',
  label: 'My Feed',
  kind: 'rss',
  category: 'tech',
  host_hint: 'example.com',
  created_at: '2026-07-18T00:00:00.000Z',
  url: 'https://example.com/feed.xml',
  ...over,
});

describe('listFeeds', () => {
  it('returns masked rows that never contain a url key', async () => {
    const { client, calls } = fakeClient({ data: [dbRow(), dbRow({ id: 'def456' })], error: null });
    const rows = await listFeeds('user-1', { client });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect('url' in row).toBe(false);
      expect(Object.keys(row).sort()).toEqual(['category', 'createdAt', 'hostHint', 'id', 'kind', 'label'].sort());
    }
    expect(rows[0]).toEqual({
      id: 'abc123', label: 'My Feed', kind: 'rss', category: 'tech',
      hostHint: 'example.com', createdAt: '2026-07-18T00:00:00.000Z',
    });
    expect(calls.eq).toContainEqual(['user_id', 'user-1']);
    expect(calls.table).toBe('user_premium_feeds');
  });

  it('returns [] for an empty result set', async () => {
    const { client } = fakeClient({ data: [], error: null });
    expect(await listFeeds('user-1', { client })).toEqual([]);
  });

  it('throws loudly on a DB error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(listFeeds('user-1', { client })).rejects.toThrow(/premium list failed/);
  });
});

describe('getOwnedFeedsWithUrls', () => {
  it('filters to user_id AND id-in-ids, and its rows carry url (internal-only)', async () => {
    const { client, calls } = fakeClient({ data: [dbRow()], error: null });
    const rows = await getOwnedFeedsWithUrls('user-1', ['abc123'], { client });
    expect(calls.eq).toContainEqual(['user_id', 'user-1']);
    expect(calls.in).toEqual(['id', ['abc123']]);
    expect(rows).toEqual([{
      id: 'abc123', url: 'https://example.com/feed.xml', label: 'My Feed',
      kind: 'rss', category: 'tech', hostHint: 'example.com',
    }]);
  });

  it('returns [] without calling the DB for an empty or non-array ids list', async () => {
    const { client } = fakeClient();
    expect(await getOwnedFeedsWithUrls('user-1', [], { client })).toEqual([]);
    expect(await getOwnedFeedsWithUrls('user-1', undefined, { client })).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('throws loudly on a DB error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(getOwnedFeedsWithUrls('user-1', ['abc123'], { client })).rejects.toThrow(/premium resolve failed/);
  });
});

describe('countFeeds', () => {
  it('returns the count scoped to user_id', async () => {
    const { client, calls } = fakeClient({ count: 3, error: null });
    expect(await countFeeds('user-1', { client })).toBe(3);
    expect(calls.eq).toContainEqual(['user_id', 'user-1']);
  });

  it('returns 0 when count is null', async () => {
    const { client } = fakeClient({ count: null, error: null });
    expect(await countFeeds('user-1', { client })).toBe(0);
  });
});

describe('findByUrl', () => {
  it('returns { id } when a match exists', async () => {
    const { client, calls } = fakeClient({ data: { id: 'abc123' }, error: null });
    expect(await findByUrl('user-1', 'https://example.com/feed.xml', { client })).toEqual({ id: 'abc123' });
    expect(calls.eq).toContainEqual(['user_id', 'user-1']);
    expect(calls.eq).toContainEqual(['url', 'https://example.com/feed.xml']);
  });

  it('returns null when no match exists', async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect(await findByUrl('user-1', 'https://example.com/feed.xml', { client })).toBeNull();
  });
});

describe('insertFeed', () => {
  const payload = {
    userId: 'user-1', url: 'https://x.com/feed', label: 'L', kind: 'rss',
    category: 'tech', hostHint: 'x.com',
  };

  it('returns a masked row and maps camelCase to snake_case on insert', async () => {
    const { client, calls } = fakeClient({ data: dbRow(), error: null });
    const row = await insertFeed(payload, { client });
    expect('url' in row).toBe(false);
    expect(calls.insert).toEqual({
      user_id: 'user-1', url: 'https://x.com/feed', label: 'L', kind: 'rss',
      category: 'tech', host_hint: 'x.com',
    });
  });

  it('maps Postgres P0001 (cap trigger) to PremiumCapError', async () => {
    const { client } = fakeClient({ data: null, error: { code: 'P0001', message: 'cap reached' } });
    await expect(insertFeed(payload, { client })).rejects.toBeInstanceOf(PremiumCapError);
  });

  it('maps Postgres 23505 (unique violation) to PremiumDuplicateError', async () => {
    const { client } = fakeClient({ data: null, error: { code: '23505', message: 'duplicate' } });
    await expect(insertFeed(payload, { client })).rejects.toBeInstanceOf(PremiumDuplicateError);
  });

  it('rethrows any other DB error as a generic Error', async () => {
    const { client } = fakeClient({ data: null, error: { code: '99999', message: 'weird' } });
    await expect(insertFeed(payload, { client })).rejects.toThrow(/premium insert failed/);
  });
});

describe('updateFeedMeta', () => {
  it('scopes the update on both user_id and id, and strips undefined fields from the patch', async () => {
    const { client, calls } = fakeClient({ data: dbRow({ label: 'New' }), error: null });
    const row = await updateFeedMeta('user-1', 'abc123', { label: 'New', kind: undefined, category: undefined }, { client });
    expect(calls.update).toEqual({ label: 'New' });
    expect(calls.eq).toContainEqual(['user_id', 'user-1']);
    expect(calls.eq).toContainEqual(['id', 'abc123']);
    expect(row.label).toBe('New');
    expect('url' in row).toBe(false);
  });

  it('returns null without calling the DB when every field is undefined', async () => {
    const { client } = fakeClient();
    expect(await updateFeedMeta('user-1', 'abc123', {}, { client })).toBeNull();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('returns null when no row matched', async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect(await updateFeedMeta('user-1', 'abc123', { label: 'New' }, { client })).toBeNull();
  });

  it('throws loudly on a DB error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(updateFeedMeta('user-1', 'abc123', { label: 'New' }, { client })).rejects.toThrow(/premium update failed/);
  });
});

describe('deleteFeed', () => {
  it('returns false when no row matched', async () => {
    const { client } = fakeClient({ data: [], error: null });
    expect(await deleteFeed('user-1', 'abc123', { client })).toBe(false);
  });

  it('returns true and scopes on user_id AND id when a row was deleted', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'abc123' }], error: null });
    expect(await deleteFeed('user-1', 'abc123', { client })).toBe(true);
    expect(calls.eq).toContainEqual(['user_id', 'user-1']);
    expect(calls.eq).toContainEqual(['id', 'abc123']);
  });

  it('throws loudly on a DB error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(deleteFeed('user-1', 'abc123', { client })).rejects.toThrow(/premium delete failed/);
  });
});
