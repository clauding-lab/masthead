import { describe, it, expect } from 'vitest';
import {
  runInboxPurge,
  purgeAgedTombstones,
  fetchByteSnapshot,
  selectPressureDeletionIds,
  hardDeleteTombstonedIds,
  InboxPurgeError,
  SNAPSHOT_PAGE_SIZE,
} from './inboxPurge.js';
import { MAX_LIVE_BYTES } from './inboxConfig.js';

// A tiny in-memory stand-in for the ONE Postgres table this module touches.
// Unlike a canned-response mock, it actually applies the predicates the
// query builder chain accumulates (.lt/.gt/.not/.in) against seeded rows, so
// a wrong comparison direction or wrong cutoff in the implementation shows up
// as a wrong result here, not just a wrong call shape. Selects additionally
// honor `.order()` (real sort, ascending) and `.range()` (real slice), and an
// unbounded select (no `.range()`) is capped at SNAPSHOT_PAGE_SIZE rows —
// simulating PostgREST's silent project-level max-rows truncation, so a
// non-paginating implementation shows up as a wrong (short) result, not a
// wrong call shape either. `failAt` simulates a DB error on the Nth `.from()`
// call (0-indexed, in call order).
function makeFakeTable(seedRows, { failAt = null } = {}) {
  let rows = seedRows.map((r) => ({ ...r }));
  const calls = [];
  let callIndex = -1;

  function builder() {
    const record = { mode: null, cols: null, predicates: [], inArgs: null, order: null, range: null };
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
      order(col) { record.order = col; return b; },
      range(from, to) { record.range = [from, to]; return b; },
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
    let ordered = matched;
    if (record.order) {
      const col = record.order;
      ordered = [...matched].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0));
    }
    // Real range() slices exactly what was asked; an unbounded select is
    // capped at SNAPSHOT_PAGE_SIZE, mirroring PostgREST's default max-rows.
    const page = record.range
      ? ordered.slice(record.range[0], record.range[1] + 1)
      : ordered.slice(0, SNAPSHOT_PAGE_SIZE);
    const cols = (record.cols || '*').split(',').map((s) => s.trim());
    const projected = page.map((row) => {
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

describe('purgeAgedTombstones', () => {
  it('hard-deletes a 31-day-old tombstone, spares a fresh one, ignores a live row, and catches a future-dated dodge', async () => {
    const rows = [
      row({ id: 'fresh', deleted_at: iso(-1) }), // tombstoned 1 day ago -> survives
      row({ id: 'stale', deleted_at: iso(-31) }), // tombstoned 31 days ago -> goes
      row({ id: 'live', deleted_at: null, received_at: iso(-400) }), // never tombstoned -> untouched
      row({ id: 'dodge', deleted_at: iso(10), received_at: iso(-31) }), // future deleted_at, 31-day-old message -> goes
      row({ id: 'safe', deleted_at: iso(10), received_at: iso(-5) }), // future deleted_at, recent message -> survives
    ];
    const { client, getRows } = makeFakeTable(rows);
    const deleted = await purgeAgedTombstones(client, NOW_MS);
    expect(deleted).toBe(2);
    expect(getRows().map((r) => r.id).sort()).toEqual(['fresh', 'live', 'safe']);
  });

  it('throws InboxPurgeError when the aged-tombstone delete errors', async () => {
    const { client } = makeFakeTable([row({ id: 't', deleted_at: iso(-31) })], { failAt: 0 });
    await expect(purgeAgedTombstones(client, NOW_MS)).rejects.toBeInstanceOf(InboxPurgeError);
  });

  it('throws InboxPurgeError when the future-dated tombstone delete errors', async () => {
    const { client } = makeFakeTable([row({ id: 't', deleted_at: iso(-31) })], { failAt: 1 });
    await expect(purgeAgedTombstones(client, NOW_MS)).rejects.toBeInstanceOf(InboxPurgeError);
  });
});

describe('fetchByteSnapshot', () => {
  it('paginates past a single page so a large snapshot is never silently truncated', async () => {
    const total = SNAPSHOT_PAGE_SIZE + 50;
    const rows = Array.from({ length: total }, (_, i) =>
      row({ id: `r-${String(i).padStart(5, '0')}`, size_bytes: 1 })
    );
    const { client, calls } = makeFakeTable(rows);
    const snapshot = await fetchByteSnapshot(client);
    expect(snapshot).toHaveLength(total);
    expect(snapshot.reduce((sum, r) => sum + r.size_bytes, 0)).toBe(total);
    const selectCalls = calls.filter((c) => c.mode === 'select');
    expect(selectCalls).toHaveLength(2); // one full page + one short (trailing) page
    expect(selectCalls.every((c) => c.order === 'id')).toBe(true);
  });

  it('throws InboxPurgeError when a page fetch errors', async () => {
    const { client } = makeFakeTable([row({ id: 'x' })], { failAt: 0 });
    await expect(fetchByteSnapshot(client)).rejects.toBeInstanceOf(InboxPurgeError);
  });
});

describe('hardDeleteTombstonedIds', () => {
  it('deletes tombstoned rows in batches of <=100', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row({ id: `t-${i}`, deleted_at: iso(-31) }));
    const { client, calls, getRows } = makeFakeTable(rows);
    const deleted = await hardDeleteTombstonedIds(client, rows.map((r) => r.id));
    expect(deleted).toBe(250);
    expect(getRows()).toHaveLength(0);
    const deleteCalls = calls.filter((c) => c.mode === 'delete');
    expect(deleteCalls).toHaveLength(3);
    expect(deleteCalls[0].inArgs).toHaveLength(100);
    expect(deleteCalls[1].inArgs).toHaveLength(100);
    expect(deleteCalls[2].inArgs).toHaveLength(50);
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

  it('detects byte pressure across a snapshot spanning multiple pages (regression: a first-page-only total would miss this)', async () => {
    const CAP = 2 * MAX_LIVE_BYTES;
    const PAGE1_COUNT = SNAPSHOT_PAGE_SIZE;
    const PAGE1_PER_ROW = Math.floor((CAP - 1000) / PAGE1_COUNT);
    const EXTRA_COUNT = 50;
    const EXTRA_PER_ROW = 1000;

    // Sanity: page 1 alone (the first SNAPSHOT_PAGE_SIZE rows in id order)
    // totals UNDER the cap, and only the full (both-page) total clears it —
    // otherwise this test wouldn't discriminate a truncated snapshot from a
    // correctly-paginated one.
    expect(PAGE1_PER_ROW * PAGE1_COUNT).toBeLessThan(CAP);
    expect(PAGE1_PER_ROW * PAGE1_COUNT + EXTRA_COUNT * EXTRA_PER_ROW).toBeGreaterThan(CAP);

    const page1Rows = Array.from({ length: PAGE1_COUNT }, (_, i) =>
      row({ id: `p1-${String(i).padStart(4, '0')}`, user_id: 'pressure-user', size_bytes: PAGE1_PER_ROW, deleted_at: iso(-5) })
    );
    const extraRows = Array.from({ length: EXTRA_COUNT }, (_, i) =>
      row({ id: `p2-${String(i).padStart(4, '0')}`, user_id: 'pressure-user', size_bytes: EXTRA_PER_ROW, deleted_at: iso(-5) })
    );
    const { client, getRows } = makeFakeTable([...page1Rows, ...extraRows]);

    const result = await runInboxPurge({ client, now: () => NOW_MS });
    expect(result.hardDeleted).toBe(0); // all tombstones are 5 days old, none aged out
    expect(result.pressureDeleted).toBeGreaterThan(0);
    expect(getRows().length).toBeLessThan(PAGE1_COUNT + EXTRA_COUNT);
  });

  it('throws InboxPurgeError when the byte-pressure snapshot fetch errors (pass a already ran)', async () => {
    // calls 0,1 = pass (a)'s two direct deletes (both no-op, no matching
    // rows); call 2 = the byte-pressure snapshot's first page fetch.
    const { client } = makeFakeTable([], { failAt: 2 });
    await expect(runInboxPurge({ client, now: () => NOW_MS })).rejects.toBeInstanceOf(InboxPurgeError);
  });

  it('throws InboxPurgeError when a pass (b) delete batch errors', async () => {
    // call 0 = aged-tombstone delete (no-op: the row is fresh, not aged);
    // call 1 = future-dated-tombstone delete (no-op: deleted_at isn't in the
    // future); call 2 = the byte snapshot fetch (over cap, single page);
    // call 3 = the pass (b) delete batch.
    const rows = [row({ id: 'p', user_id: 'u1', size_bytes: 2 * MAX_LIVE_BYTES + 5, deleted_at: iso(-1) })];
    const { client } = makeFakeTable(rows, { failAt: 3 });
    await expect(runInboxPurge({ client, now: () => NOW_MS })).rejects.toBeInstanceOf(InboxPurgeError);
  });
});
