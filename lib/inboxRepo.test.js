import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  findAddressBySlug, getAddressRow, ensureAddress, rotateSlug, disableSlug,
  quotaSnapshot, insertMessage, markDeferred, clearDeferred,
  InboxRepoError,
} from './inboxRepo.js';

vi.mock('./ingestSlug.js', () => ({
  generateSlug: vi.fn(),
}));
import { generateSlug } from './ingestSlug.js';

beforeEach(() => {
  generateSlug.mockReset();
});

// Chained Supabase query-builder mock, mirroring lib/premiumRepo.test.js's
// fakeClient, but queue-based: inboxRepo functions can make MULTIPLE
// sequential .from() round trips (quotaSnapshot: count + sum; markDeferred:
// select + update; ensureAddress/rotateSlug: retries on 23505). One entry in
// `responses` is consumed per `.from()` call; the last entry repeats once
// the queue is exhausted. `calls` is one record per `.from()` invocation, in
// order, so tests can assert both aggregate behavior and call sequencing.
function fakeAdmin(responses = [{ data: null, error: null }]) {
  const queue = [...responses];
  const calls = [];
  const client = {
    from: vi.fn((table) => {
      const record = { table, eq: [], is: [] };
      calls.push(record);
      const result = queue.length > 1 ? queue.shift() : queue[0];
      const builder = {
        select: vi.fn((cols, opts) => { record.select = { cols, opts }; return builder; }),
        insert: vi.fn((row) => { record.insert = row; return builder; }),
        update: vi.fn((patch) => { record.update = patch; return builder; }),
        delete: vi.fn(() => { record.delete = true; return builder; }),
        upsert: vi.fn((row, opts) => { record.upsert = { row, opts }; return builder; }),
        eq: vi.fn((col, val) => { record.eq.push([col, val]); return builder; }),
        is: vi.fn((col, val) => { record.is.push([col, val]); return builder; }),
        order: vi.fn((col, opts) => { record.order = [col, opts]; return builder; }),
        maybeSingle: vi.fn(() => Promise.resolve(result)),
        single: vi.fn(() => Promise.resolve(result)),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    }),
  };
  return { client, calls };
}

const addressDbRow = (over = {}) => ({
  id: 'addr-1',
  user_id: 'user-1',
  slug: 'cedar-otter-4f2a',
  over_quota_since: null,
  deferred_count: 0,
  last_deferred_at: null,
  created_at: '2026-07-31T00:00:00.000Z',
  ...over,
});

describe('findAddressBySlug', () => {
  it('returns the camelCased shape when a row matches', async () => {
    const { client, calls } = fakeAdmin([{ data: { id: 'addr-1', user_id: 'user-1', over_quota_since: null }, error: null }]);
    const row = await findAddressBySlug('cedar-otter-4f2a', { client });
    expect(row).toEqual({ id: 'addr-1', userId: 'user-1', overQuotaSince: null });
    expect(calls[0].table).toBe('user_ingest_addresses');
    expect(calls[0].eq).toContainEqual(['slug', 'cedar-otter-4f2a']);
  });

  it('returns null when no row matches', async () => {
    const { client } = fakeAdmin([{ data: null, error: null }]);
    expect(await findAddressBySlug('missing-slug-0000', { client })).toBeNull();
  });

  it('throws InboxRepoError on a DB error', async () => {
    const { client } = fakeAdmin([{ data: null, error: { message: 'boom' } }]);
    await expect(findAddressBySlug('x-y-0000', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });
});

describe('getAddressRow', () => {
  it('returns the full camelCased row scoped to user_id', async () => {
    const { client, calls } = fakeAdmin([{ data: addressDbRow(), error: null }]);
    const row = await getAddressRow('user-1', { client });
    expect(row).toEqual({
      id: 'addr-1', userId: 'user-1', slug: 'cedar-otter-4f2a', overQuotaSince: null,
      deferredCount: 0, lastDeferredAt: null, createdAt: '2026-07-31T00:00:00.000Z',
    });
    expect(calls[0].eq).toContainEqual(['user_id', 'user-1']);
  });

  it('returns null when the user has no address row', async () => {
    const { client } = fakeAdmin([{ data: null, error: null }]);
    expect(await getAddressRow('user-1', { client })).toBeNull();
  });

  it('throws InboxRepoError on a DB error', async () => {
    const { client } = fakeAdmin([{ data: null, error: { message: 'boom' } }]);
    await expect(getAddressRow('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });
});

describe('ensureAddress', () => {
  it('returns the existing row without writing when a slug is already set', async () => {
    const { client, calls } = fakeAdmin([{ data: addressDbRow(), error: null }]);
    const row = await ensureAddress('user-1', { client });
    expect(row.slug).toBe('cedar-otter-4f2a');
    expect(calls).toHaveLength(1);
    expect(calls[0].upsert).toBeUndefined();
  });

  it('upserts a fresh slug when no row exists', async () => {
    generateSlug.mockReturnValue('willow-lynx-00ab');
    const { client, calls } = fakeAdmin([
      { data: null, error: null }, // select: no existing row
      { data: addressDbRow({ slug: 'willow-lynx-00ab' }), error: null }, // upsert
    ]);
    const row = await ensureAddress('user-1', { client });
    expect(row.slug).toBe('willow-lynx-00ab');
    expect(calls[1].upsert).toEqual({ row: { user_id: 'user-1', slug: 'willow-lynx-00ab' }, opts: { onConflict: 'user_id' } });
  });

  it('retries a slug collision then succeeds', async () => {
    generateSlug.mockReturnValueOnce('taken-slug-0001').mockReturnValueOnce('free-slug-0002');
    const { client, calls } = fakeAdmin([
      { data: null, error: null }, // select: no existing row
      { data: null, error: { code: '23505', message: 'duplicate key' } }, // 1st upsert collides
      { data: addressDbRow({ slug: 'free-slug-0002' }), error: null }, // 2nd upsert succeeds
    ]);
    const row = await ensureAddress('user-1', { client });
    expect(row.slug).toBe('free-slug-0002');
    expect(calls).toHaveLength(3);
  });

  it('throws InboxRepoError after exhausting slug retries', async () => {
    generateSlug.mockReturnValue('always-taken-0000');
    const collision = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const { client, calls } = fakeAdmin([{ data: null, error: null }, collision, collision, collision]);
    await expect(ensureAddress('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
    expect(calls).toHaveLength(4); // 1 select + 3 upsert attempts, no 4th attempt
  });

  it('throws InboxRepoError on a non-collision DB error without retrying', async () => {
    generateSlug.mockReturnValue('any-slug-0000');
    const { client, calls } = fakeAdmin([
      { data: null, error: null },
      { data: null, error: { code: '42501', message: 'permission denied' } },
    ]);
    await expect(ensureAddress('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
    expect(calls).toHaveLength(2);
  });
});

describe('rotateSlug', () => {
  it('updates the row in place and never deletes or inserts', async () => {
    generateSlug.mockReturnValue('fresh-slug-9999');
    const { client, calls } = fakeAdmin([{ data: addressDbRow({ slug: 'fresh-slug-9999' }), error: null }]);
    const row = await rotateSlug('user-1', { client });
    expect(row.slug).toBe('fresh-slug-9999');
    expect(calls[0].update).toEqual({ slug: 'fresh-slug-9999' });
    expect(calls[0].eq).toContainEqual(['user_id', 'user-1']);
    expect(calls[0].insert).toBeUndefined();
    expect(calls[0].delete).toBeUndefined();
    expect(calls[0].upsert).toBeUndefined();
  });

  it('retries on unique violation up to 3 times', async () => {
    generateSlug.mockReturnValue('collide-0000');
    const collision = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const { client, calls } = fakeAdmin([collision, collision, { data: addressDbRow({ slug: 'collide-0000' }), error: null }]);
    const row = await rotateSlug('user-1', { client });
    expect(row).toBeTruthy();
    expect(calls).toHaveLength(3);
  });

  it('throws InboxRepoError after exhausting retries', async () => {
    generateSlug.mockReturnValue('collide-0000');
    const collision = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const { client, calls } = fakeAdmin([collision, collision, collision]);
    await expect(rotateSlug('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
    expect(calls).toHaveLength(3);
  });
});

describe('disableSlug', () => {
  it('sets slug to null scoped to user_id', async () => {
    const { client, calls } = fakeAdmin([{ error: null }]);
    await disableSlug('user-1', { client });
    expect(calls[0].update).toEqual({ slug: null });
    expect(calls[0].eq).toContainEqual(['user_id', 'user-1']);
  });

  it('throws InboxRepoError on a DB error', async () => {
    const { client } = fakeAdmin([{ error: { message: 'boom' } }]);
    await expect(disableSlug('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });
});

describe('quotaSnapshot', () => {
  it('returns messageCount and bytesUsed over live (non-deleted) rows', async () => {
    const { client, calls } = fakeAdmin([
      { count: 2, error: null },
      { data: [{ size_bytes: 1000 }, { size_bytes: 2500 }], error: null },
    ]);
    const snapshot = await quotaSnapshot('user-1', { client });
    expect(snapshot).toEqual({ messageCount: 2, bytesUsed: 3500 });
    expect(calls[0].is).toContainEqual(['deleted_at', null]);
    expect(calls[1].is).toContainEqual(['deleted_at', null]);
  });

  it('returns zeros when the user has no live messages', async () => {
    const { client } = fakeAdmin([{ count: 0, error: null }, { data: [], error: null }]);
    expect(await quotaSnapshot('user-1', { client })).toEqual({ messageCount: 0, bytesUsed: 0 });
  });

  it('returns zero count when count is null', async () => {
    const { client } = fakeAdmin([{ count: null, error: null }, { data: [], error: null }]);
    expect(await quotaSnapshot('user-1', { client })).toEqual({ messageCount: 0, bytesUsed: 0 });
  });

  it('throws InboxRepoError when the count query errors', async () => {
    const { client } = fakeAdmin([{ count: null, error: { message: 'boom' } }]);
    await expect(quotaSnapshot('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });

  it('throws InboxRepoError when the sum query errors', async () => {
    const { client } = fakeAdmin([{ count: 1, error: null }, { data: null, error: { message: 'boom' } }]);
    await expect(quotaSnapshot('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });
});

describe('insertMessage', () => {
  const payload = {
    userId: 'user-1', fromEmail: 'sender@example.com', fromName: 'Sender',
    subject: 'Hello', html: '<p>hi</p>', text: 'hi', excerpt: 'hi',
    sizeBytes: 4, webUrl: null, unsubscribeUrl: null, authResults: null,
    dedupeKey: 'dedupe-1', messageId: '<abc@example.com>',
  };

  it('maps camelCase to snake_case columns and returns inserted on success', async () => {
    const { client, calls } = fakeAdmin([{ error: null }]);
    const verdict = await insertMessage(payload, { client });
    expect(verdict).toBe('inserted');
    expect(calls[0].table).toBe('user_inbox_messages');
    expect(calls[0].insert).toEqual({
      user_id: 'user-1', from_email: 'sender@example.com', from_name: 'Sender',
      subject: 'Hello', html_body: '<p>hi</p>', text_body: 'hi', excerpt: 'hi',
      size_bytes: 4, web_url: null, unsubscribe_url: null, auth_results: null,
      dedupe_key: 'dedupe-1', message_id: '<abc@example.com>',
    });
  });

  it('maps a unique-violation on the dedupe constraint to duplicate', async () => {
    const { client } = fakeAdmin([{ error: { code: '23505' } }]);
    expect(await insertMessage(payload, { client })).toBe('duplicate');
  });

  it('maps a quota-trigger exception message to over_quota', async () => {
    const { client } = fakeAdmin([{ error: { message: 'inbox quota exceeded for user' } }]);
    expect(await insertMessage(payload, { client })).toBe('over_quota');
  });

  it('throws InboxRepoError on any other DB error', async () => {
    const { client } = fakeAdmin([{ error: { code: '42501', message: 'permission denied' } }]);
    await expect(insertMessage(payload, { client })).rejects.toBeInstanceOf(InboxRepoError);
  });

  it('coerces a null subject to empty string (NOT NULL column)', async () => {
    const { client, calls } = fakeAdmin([{ error: null }]);
    await insertMessage({ ...payload, subject: null }, { client });
    expect(calls[0].insert.subject).toBe('');
  });
});

describe('markDeferred', () => {
  it('sets over_quota_since only on first defer and increments the counter', async () => {
    const { client, calls } = fakeAdmin([
      { data: { over_quota_since: null, deferred_count: 0 }, error: null },
      { error: null },
    ]);
    await markDeferred('user-1', { client });
    expect(calls[1].update.deferred_count).toBe(1);
    expect(typeof calls[1].update.over_quota_since).toBe('string');
    expect(typeof calls[1].update.last_deferred_at).toBe('string');
  });

  it('does not overwrite an already-set over_quota_since', async () => {
    const { client, calls } = fakeAdmin([
      { data: { over_quota_since: '2026-07-30T00:00:00.000Z', deferred_count: 3 }, error: null },
      { error: null },
    ]);
    await markDeferred('user-1', { client });
    expect(calls[1].update.over_quota_since).toBe('2026-07-30T00:00:00.000Z');
    expect(calls[1].update.deferred_count).toBe(4);
  });

  it('throws InboxRepoError when the lookup errors', async () => {
    const { client } = fakeAdmin([{ data: null, error: { message: 'boom' } }]);
    await expect(markDeferred('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });

  it('throws InboxRepoError when the update errors', async () => {
    const { client } = fakeAdmin([
      { data: { over_quota_since: null, deferred_count: 0 }, error: null },
      { error: { message: 'boom' } },
    ]);
    await expect(markDeferred('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });
});

describe('clearDeferred', () => {
  it('resets over_quota_since to null scoped to user_id', async () => {
    const { client, calls } = fakeAdmin([{ error: null }]);
    await clearDeferred('user-1', { client });
    expect(calls[0].update).toEqual({ over_quota_since: null });
    expect(calls[0].eq).toContainEqual(['user_id', 'user-1']);
  });

  it('throws InboxRepoError on a DB error', async () => {
    const { client } = fakeAdmin([{ error: { message: 'boom' } }]);
    await expect(clearDeferred('user-1', { client })).rejects.toBeInstanceOf(InboxRepoError);
  });
});
