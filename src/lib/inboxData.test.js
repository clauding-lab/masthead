import { describe, it, expect, vi, beforeEach } from 'vitest';

// A minimal chainable stand-in for the supabase-js query builder, in the
// same spirit as src/lib/sync.test.js's mock: it records the shape of each
// call (table, select columns + opts, update patch, filters, order, limit)
// so assertions can inspect exactly what was sent, and resolves every
// terminal await from a single `nextResult` the test sets beforehand.
// `delete` is tracked separately so removeMessage/clearRead tests can prove
// it was never invoked (landmine 23/25: tombstone via UPDATE only).
const calls = [];
const deleteCalls = [];
let nextResult = { data: null, error: null, count: null };

vi.mock('./supabase', () => ({
  supabase: {
    from: (table) => {
      const record = {
        table, select: null, selectOpts: null, updatePatch: null, filters: [], order: null, limit: null,
      };
      calls.push(record);
      const chain = {
        select(cols, opts) { record.select = cols; record.selectOpts = opts; return chain; },
        update(patch) { record.updatePatch = patch; return chain; },
        delete() { deleteCalls.push(record); return chain; },
        eq(col, val) { record.filters.push({ op: 'eq', col, val }); return chain; },
        is(col, val) { record.filters.push({ op: 'is', col, val }); return chain; },
        not(col, subOp, val) { record.filters.push({ op: 'not', col, subOp, val }); return chain; },
        order(col, opts) { record.order = { col, opts }; return chain; },
        limit(n) { record.limit = n; return chain; },
        single() { return chain; },
        then(resolve, reject) { return Promise.resolve(nextResult).then(resolve, reject); },
      };
      return chain;
    },
  },
}));

import {
  listMessages, getMessage, markRead, removeMessage, clearRead, unreadCount,
} from './inboxData.js';

beforeEach(() => {
  calls.length = 0;
  deleteCalls.length = 0;
  nextResult = { data: null, error: null, count: null };
});

describe('listMessages', () => {
  it('selects metadata columns only — the literal select string excludes html_body and text_body', async () => {
    nextResult = { data: [], error: null };
    await listMessages();
    const call = calls[0];
    expect(call.table).toBe('user_inbox_messages');
    expect(call.select).not.toMatch(/html_body/);
    expect(call.select).not.toMatch(/text_body/);
    for (const col of [
      'id', 'from_email', 'from_name', 'subject', 'excerpt', 'received_at',
      'read_at', 'web_url', 'unsubscribe_url', 'auth_results', 'size_bytes',
    ]) {
      expect(call.select).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('scopes to live rows and orders received_at desc', async () => {
    nextResult = { data: [], error: null };
    await listMessages();
    const call = calls[0];
    expect(call.filters).toContainEqual({ op: 'is', col: 'deleted_at', val: null });
    expect(call.order).toEqual({ col: 'received_at', opts: { ascending: false } });
  });

  it('defaults the limit to 100 and honors an explicit limit', async () => {
    nextResult = { data: [], error: null };
    await listMessages();
    expect(calls[0].limit).toBe(100);
    await listMessages({ limit: 10 });
    expect(calls[1].limit).toBe(10);
  });

  it('returns the fetched rows', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    nextResult = { data: rows, error: null };
    expect(await listMessages()).toEqual(rows);
  });

  it('returns an empty array when data is null', async () => {
    nextResult = { data: null, error: null };
    expect(await listMessages()).toEqual([]);
  });

  it('throws the supabase error when the select fails', async () => {
    nextResult = { data: null, error: { message: 'boom' } };
    await expect(listMessages()).rejects.toEqual({ message: 'boom' });
  });
});

describe('getMessage', () => {
  it('fetches a single row by id, including body columns', async () => {
    const row = { id: 'm1', html_body: '<p>x</p>', text_body: 'x' };
    nextResult = { data: row, error: null };
    const result = await getMessage('m1');
    expect(result).toEqual(row);
    expect(calls[0].table).toBe('user_inbox_messages');
    expect(calls[0].filters).toContainEqual({ op: 'eq', col: 'id', val: 'm1' });
  });

  it('throws the supabase error when the row fetch fails', async () => {
    nextResult = { data: null, error: { message: 'not found' } };
    await expect(getMessage('missing')).rejects.toEqual({ message: 'not found' });
  });
});

describe('markRead', () => {
  it('UPDATEs read_at for the given id and never calls delete', async () => {
    nextResult = { error: null };
    await markRead('m1');
    const call = calls[0];
    expect(typeof call.updatePatch.read_at).toBe('string');
    expect(call.filters).toContainEqual({ op: 'eq', col: 'id', val: 'm1' });
    expect(deleteCalls).toHaveLength(0);
  });

  it('throws the supabase error when the update fails', async () => {
    nextResult = { error: { message: 'nope' } };
    await expect(markRead('m1')).rejects.toEqual({ message: 'nope' });
  });
});

describe('removeMessage', () => {
  it('tombstones via UPDATE deleted_at, never DELETE', async () => {
    nextResult = { error: null };
    await removeMessage('m1');
    const call = calls[0];
    expect(typeof call.updatePatch.deleted_at).toBe('string');
    expect(call.filters).toContainEqual({ op: 'eq', col: 'id', val: 'm1' });
    expect(deleteCalls).toHaveLength(0);
  });

  it('throws the supabase error when the tombstone update fails', async () => {
    nextResult = { error: { message: 'nope' } };
    await expect(removeMessage('m1')).rejects.toEqual({ message: 'nope' });
  });
});

describe('clearRead', () => {
  it('tombstones every read, still-live message via UPDATE — filters read_at not null — never DELETE', async () => {
    nextResult = { error: null };
    await clearRead();
    const call = calls[0];
    expect(typeof call.updatePatch.deleted_at).toBe('string');
    expect(call.filters).toContainEqual({ op: 'not', col: 'read_at', subOp: 'is', val: null });
    expect(call.filters).toContainEqual({ op: 'is', col: 'deleted_at', val: null });
    expect(deleteCalls).toHaveLength(0);
  });

  it('throws the supabase error when the bulk update fails', async () => {
    nextResult = { error: { message: 'nope' } };
    await expect(clearRead()).rejects.toEqual({ message: 'nope' });
  });
});

describe('unreadCount', () => {
  it('counts unread, live rows via count: exact, head: true', async () => {
    nextResult = { count: 4, error: null };
    const result = await unreadCount();
    expect(result).toBe(4);
    const call = calls[0];
    expect(call.selectOpts).toEqual({ count: 'exact', head: true });
    expect(call.filters).toContainEqual({ op: 'is', col: 'read_at', val: null });
    expect(call.filters).toContainEqual({ op: 'is', col: 'deleted_at', val: null });
  });

  it('returns 0 when count comes back null', async () => {
    nextResult = { count: null, error: null };
    expect(await unreadCount()).toBe(0);
  });

  it('throws the supabase error when the count query fails', async () => {
    nextResult = { count: null, error: { message: 'nope' } };
    await expect(unreadCount()).rejects.toEqual({ message: 'nope' });
  });
});
