import { describe, it, expect } from 'vitest';
import {
  runInboxPurge,
  fetchTombstoneAgeCandidateIds,
  selectPressureDeletionIds,
  hardDeleteTombstonedIds,
  InboxPurgeError,
} from './inboxPurge.js';
import { MAX_LIVE_BYTES } from './inboxConfig.js';

// A tiny in-memory stand-in for the ONE Postgres table this module touches.
// Unlike a canned-response mock, it actually applies the predicates the
// query builder chain accumulates (.lt/.gt/.not/.in) against seeded rows, so
// a wrong comparison direction or wrong cutoff in the implementation shows up
// as a wrong result here, not just a wrong call shape. `failAt` simulates a
// DB error on the Nth `.from()` call (0-indexed, in call order).
function makeFakeTable(seedRows, { failAt = null } = {}) {
  let rows = seedRows.map((r) => ({ ...r }));
  const calls = [];
  let callIndex = -1;

  function builder() {
    const record = { mode: null, cols: null, predicates: [], inArgs: null };
    const idx = ++callIndex;
    calls.push(record);
    const b = {
      select(cols) { record.mode = 'select'; record.cols = cols; return b; },
      delete() { record.mode = 'delete'; return b; },
      lt(col, val) { record.predicates.push((row) => row[col] != null && row[col] < val); return b; },
      gt(col, val) { record.predicates.push((row) => row[col] != null && row[col] > val); return b; },
      not(col, op, val) {
        if (op !== 'is' || val !== null) throw new Error(`fake table: unsupported .not(${col}, ${op}, ${val})`);
        record.predicates.push((row) => row[col] != null);
        return b;
      },
      in(col, arr) {
        record.inArgs = arr;
        record.predicates.push((row) => arr.includes(row[col]));
        return b;
      },
      then(resolve, reject) {
        return resolveCall(record, idx).then(resolve, reject);
      },
    };
    return b;
  }

  async function resolveCall(record) {
    const idx = calls.indexOf(record);
    if (failAt !== null && idx === failAt) {
      return { data: null, error: { code: 'FAKE', message: 'simulated failure' } };
    }
    const matched = rows.filter((row) => record.predicates.every((p) => p(row)));
    if (record.mode === 'delete') {
      const matchedIds = new Set(matched.map((r) => r.id));
      rows = rows.filter((r) => !matchedIds.has(r.id));
      return { data: null, error: null, count: matched.length };
    }
    const cols = (record.cols || '*').split(',').map((s) => s.trim());
    const projected = matched.map((row) => {
      if (cols.includes('*')) return { ...row };
      const out = {};
      for (const c of cols) out[c] = row[c];
      return out;
    });
    return { data: projected, error: null };
  }

  return { client: { from: () => builder() }, calls, getRows: () => rows };
}

const NOW_MS = Date.parse('2026-08-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(NOW_MS + offsetDays * DAY_MS).toISOString();

function row(over = {}) {
  return {
    id: over.id, user_id: 'user-1', size_bytes: 10, deleted_at: null, received_at: iso(-1), ...over,
  };
}

describe('fetchTombstoneAgeCandidateIds', () => {
  it('flags a 31-day-old tombstone, spares a fresh one, ignores a live row, and catches a future-dated dodge', async () => {
    const rows = [
      row({ id: 'fresh', deleted_at: iso(-1) }), // tombstoned 1 day ago -> survives
      row({ id: 'stale', deleted_at: iso(-31) }), // tombstoned 31 days ago -> goes
      row({ id: 'live', deleted_at: null, received_at: iso(-400) }), // never tombstoned -> untouched
      row({ id: 'dodge', deleted_at: iso(10), received_at: iso(-31) }), // future deleted_at, 31-day-old message -> goes
      row({ id: 'safe', deleted_at: iso(10), received_at: iso(-5) }), // future deleted_at, recent message -> survives
    ];
    const { client } = makeFakeTable(rows);
    const ids = await fetchTombstoneAgeCandidateIds(client, NOW_MS);
    expect([...ids].sort()).toEqual(['dodge', 'stale']);
  });

  it('throws InboxPurgeError when the aged-tombstone fetch errors', async () => {
    const { client } = makeFakeTable([], { failAt: 0 });
    await expect(fetchTombstoneAgeCandidateIds(client, NOW_MS)).rejects.toBeInstanceOf(InboxPurgeError);
  });

  it('throws InboxPurgeError when the future-dated fetch errors', async () => {
    const { client } = makeFakeTable([], { failAt: 1 });
    await expect(fetchTombstoneAgeCandidateIds(client, NOW_MS)).rejects.toBeInstanceOf(InboxPurgeError);
  });
});

describe('hardDeleteTombstonedIds', () => {
  it('deletes tombstoned rows in batches of <=500', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => row({ id: `t-${i}`, deleted_at: iso(-31) }));
    const { client, calls, getRows } = makeFakeTable(rows);
    const deleted = await hardDeleteTombstonedIds(client, rows.map((r) => r.id));
    expect(deleted).toBe(501);
    expect(getRows()).toHaveLength(0);
    const deleteCalls = calls.filter((c) => c.mode === 'delete');
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0].inArgs).toHaveLength(500);
    expect(deleteCalls[1].inArgs).toHaveLength(1);
  });

  // Invariant 1 (belt and braces): every delete's filter chain re-asserts
  // deleted_at is not null, even when the id list handed in was already
  // supposed to be tombstone-scoped. Prove the guard itself works by
  // deliberately poisoning the id list with a live row's id.
  it('never deletes a live row even when its id is smuggled into the batch', async () => {
    const rows = [
      row({ id: 'live', deleted_at: null }),
      row({ id: 'tomb', deleted_at: iso(-31) }),
    ];
    const { client, getRows } = makeFakeTable(rows);
    const deleted = await hardDeleteTombstonedIds(client, ['live', 'tomb']);
    expect(deleted).toBe(1);
    expect(getRows().map((r) => r.id)).toEqual(['live']);
  });

  it('makes zero calls and returns 0 for an empty id list', async () => {
    const { client, calls } = makeFakeTable([]);
    expect(await hardDeleteTombstonedIds(client, [])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('throws InboxPurgeError when a batch errors', async () => {
    const { client } = makeFakeTable([row({ id: 't', deleted_at: iso(-31) })], { failAt: 0 });
    await expect(hardDeleteTombstonedIds(client, ['t'])).rejects.toBeInstanceOf(InboxPurgeError);
  });
});

describe('selectPressureDeletionIds', () => {
  it('selects nothing at or below the threshold', () => {
    const rows = [row({ id: 'a', size_bytes: 500, deleted_at: iso(-1) }), row({ id: 'b', size_bytes: 500 })];
    expect(selectPressureDeletionIds(rows, 1000)).toEqual([]);
  });

  it('selects oldest tombstoned rows first until under threshold; live rows are never candidates', () => {
    const rows = [
      row({ id: 'live', size_bytes: 400, deleted_at: null }),
      row({ id: 'oldest-tomb', size_bytes: 300, deleted_at: iso(-20) }),
      row({ id: 'newer-tomb', size_bytes: 300, deleted_at: iso(-5) }),
    ];
    // total 1000, threshold 500 -> overage 500, needs both tombstones
    expect(selectPressureDeletionIds(rows, 500)).toEqual(['oldest-tomb', 'newer-tomb']);
  });

  it('stops as soon as the running total is back under threshold', () => {
    const rows = [
      row({ id: 'oldest', size_bytes: 600, deleted_at: iso(-20) }),
      row({ id: 'newer', size_bytes: 600, deleted_at: iso(-5) }),
    ];
    // total 1200, threshold 700 -> overage 500, the oldest row (600) alone clears it
    expect(selectPressureDeletionIds(rows, 700)).toEqual(['oldest']);
  });

  it('deletes every available tombstone when that alone cannot clear the overage (never touches live rows)', () => {
    const rows = [
      row({ id: 'live', size_bytes: 5000, deleted_at: null }),
      row({ id: 'tomb', size_bytes: 100, deleted_at: iso(-20) }),
    ];
    expect(selectPressureDeletionIds(rows, 1000)).toEqual(['tomb']);
  });

  it('evaluates each user independently', () => {
    const rows = [
      row({ id: 'u1-tomb', user_id: 'u1', size_bytes: 900, deleted_at: iso(-10) }),
      row({ id: 'u1-live', user_id: 'u1', size_bytes: 900, deleted_at: null }),
      row({ id: 'u2-tomb', user_id: 'u2', size_bytes: 100, deleted_at: iso(-10) }),
      row({ id: 'u2-live', user_id: 'u2', size_bytes: 100, deleted_at: null }),
    ];
    // u1 total 1800 > 1000 threshold; u2 total 200 <= 1000 threshold
    expect(selectPressureDeletionIds(rows, 1000)).toEqual(['u1-tomb']);
  });

  it('triggers only strictly above 2x MAX_LIVE_BYTES using the real production threshold', () => {
    const cap = MAX_LIVE_BYTES;
    const atCap = [row({ id: 'a', size_bytes: 2 * cap, deleted_at: iso(-5) })];
    expect(selectPressureDeletionIds(atCap)).toEqual([]);
    const overCap = [row({ id: 'b', size_bytes: 2 * cap + 1, deleted_at: iso(-5) })];
    expect(selectPressureDeletionIds(overCap)).toEqual(['b']);
  });
});

describe('runInboxPurge', () => {
  it('runs both passes and reports counts; a live row survives both', async () => {
    const rows = [
      row({ id: 'stale-tomb', user_id: 'u1', size_bytes: 10, deleted_at: iso(-31) }),
      row({ id: 'live', user_id: 'u1', size_bytes: 10, deleted_at: null, received_at: iso(-400) }),
      row({ id: 'pressure-tomb', user_id: 'u2', size_bytes: 2 * MAX_LIVE_BYTES + 5, deleted_at: iso(-1) }),
    ];
    const { client, getRows } = makeFakeTable(rows);
    const result = await runInboxPurge({ client, now: () => NOW_MS });
    expect(result).toEqual({ ok: true, hardDeleted: 1, pressureDeleted: 1 });
    const remainingIds = getRows().map((r) => r.id);
    expect(remainingIds).toEqual(['live']);
  });

  it('computes byte pressure over the state AFTER pass (a) removes aged tombstones', async () => {
    // u1's only tombstone is 31 days old AND, alone, pushes the user over the
    // pressure cap. Pass (a) removes it first; pass (b) must then see the
    // user back under the cap and leave the live row untouched.
    const rows = [
      row({ id: 'aged-big-tomb', user_id: 'u1', size_bytes: 2 * MAX_LIVE_BYTES + 5, deleted_at: iso(-31) }),
      row({ id: 'live', user_id: 'u1', size_bytes: 10, deleted_at: null }),
    ];
    const { client, getRows } = makeFakeTable(rows);
    const result = await runInboxPurge({ client, now: () => NOW_MS });
    expect(result).toEqual({ ok: true, hardDeleted: 1, pressureDeleted: 0 });
    expect(getRows().map((r) => r.id)).toEqual(['live']);
  });

  it('throws InboxPurgeError when the byte-pressure snapshot fetch errors (pass a already ran)', async () => {
    // calls 0,1 = pass (a)'s two candidate fetches (both empty, no deletes);
    // call 2 = the byte-pressure snapshot fetch.
    const { client } = makeFakeTable([], { failAt: 2 });
    await expect(runInboxPurge({ client, now: () => NOW_MS })).rejects.toBeInstanceOf(InboxPurgeError);
  });

  it('throws InboxPurgeError when a pass (a) delete batch errors', async () => {
    // call 0 = aged-candidate fetch (matches), call 1 = future-dated fetch
    // (empty), call 2 = the pass (a) delete batch.
    const rows = [row({ id: 't', deleted_at: iso(-31) })];
    const { client } = makeFakeTable(rows, { failAt: 2 });
    await expect(runInboxPurge({ client, now: () => NOW_MS })).rejects.toBeInstanceOf(InboxPurgeError);
  });

  it('throws InboxPurgeError when a pass (b) delete batch errors', async () => {
    // call 0,1 = pass (a) candidate fetches (empty), call 2 = byte snapshot
    // (over cap, no pass-a deletes to make a call 2 collide with), call 3 =
    // the pass (b) delete batch.
    const rows = [row({ id: 'p', user_id: 'u1', size_bytes: 2 * MAX_LIVE_BYTES + 5, deleted_at: iso(-1) })];
    const { client } = makeFakeTable(rows, { failAt: 3 });
    await expect(runInboxPurge({ client, now: () => NOW_MS })).rejects.toBeInstanceOf(InboxPurgeError);
  });
});
