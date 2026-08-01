// lib/inboxPurge.js — the ONLY component in Phase 3 permitted to hard-delete
// user_inbox_messages rows, and only tombstoned ones (spec §5.3). Deletes
// elsewhere in the app are soft (deleted_at tombstones); this cron is where
// tombstones actually leave the table, so every delete's filter chain
// re-asserts `deleted_at is not null` even when the id list handed in was
// already supposed to be tombstone-scoped — belt and braces, a live row must
// be unreachable by construction (landmine 11: check {error} on every call).
//
// Two passes:
//   (a) hard-delete tombstones older than 30 days. supabase-js can't express
//       `least(deleted_at, now())`, so a future-dated deleted_at is caught by
//       a second, independent eligibility path keyed on received_at —
//       otherwise a client could set deleted_at far in the future and dodge
//       the purge forever (spec: "values in the future are treated as now()
//       by the purge").
//   (b) byte pressure: for a user whose TOTAL bytes (live + tombstoned)
//       exceed 2x MAX_LIVE_BYTES, hard-delete their oldest tombstones until
//       back under — live rows are never eligible, they only count toward
//       the total. Runs after pass (a), over the post-pass-(a) state.
import { getAdminClient } from './supabaseAdmin.js';
import { MAX_LIVE_BYTES } from './inboxConfig.js';

export class InboxPurgeError extends Error {}

const TABLE = 'user_inbox_messages';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;
const PRESSURE_THRESHOLD_BYTES = 2 * MAX_LIVE_BYTES;

function client(deps) {
  return deps.client || getAdminClient();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Pass (a) candidates: two filtered fetches, merged — never a full table
// scan. `deleted_at < cutoff` and `deleted_at > now` both naturally exclude
// live rows (deleted_at IS NULL fails every comparison), so no extra guard
// is needed on the SELECT side; the DELETE side still re-asserts it (above).
export async function fetchTombstoneAgeCandidateIds(c, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - THIRTY_DAYS_MS).toISOString();

  const { data: aged, error: agedError } = await c.from(TABLE).select('id').lt('deleted_at', cutoffIso);
  if (agedError) {
    throw new InboxPurgeError(`tombstone-age candidate fetch failed: ${agedError.code || agedError.message}`);
  }

  const { data: futureDated, error: futureError } = await c
    .from(TABLE)
    .select('id')
    .gt('deleted_at', nowIso)
    .lt('received_at', cutoffIso);
  if (futureError) {
    throw new InboxPurgeError(`tombstone-age candidate fetch failed: ${futureError.code || futureError.message}`);
  }

  return [...new Set([...(aged || []), ...(futureDated || [])].map((r) => r.id))];
}

// Batched hard-delete, <=500 ids per `.in()` (landmine 11: {error} checked
// per batch, so one bad batch strands only itself, not the whole run).
export async function hardDeleteTombstonedIds(c, ids) {
  let deleted = 0;
  for (const batch of chunk(ids, BATCH_SIZE)) {
    const { error, count } = await c
      .from(TABLE)
      .delete({ count: 'exact' })
      .in('id', batch)
      .not('deleted_at', 'is', null);
    if (error) throw new InboxPurgeError(`purge delete batch failed: ${error.code || error.message}`);
    deleted += count ?? batch.length;
  }
  return deleted;
}

// Pass (b) selection is a pure function over an in-memory row snapshot
// (id/user_id/size_bytes/deleted_at), independent of the query builder, so
// the "oldest tombstoned rows first, until under threshold" rule is directly
// unit-testable. Only tombstoned rows are ever collected as candidates; live
// rows count toward the user's total but can never be selected.
export function selectPressureDeletionIds(rows, thresholdBytes = PRESSURE_THRESHOLD_BYTES) {
  const byUser = new Map();
  for (const row of rows) {
    const bucket = byUser.get(row.user_id) || { total: 0, tombstoned: [] };
    bucket.total += row.size_bytes || 0;
    if (row.deleted_at != null) bucket.tombstoned.push(row);
    byUser.set(row.user_id, bucket);
  }

  const ids = [];
  for (const bucket of byUser.values()) {
    if (bucket.total <= thresholdBytes) continue;
    let overage = bucket.total - thresholdBytes;
    const oldestFirst = [...bucket.tombstoned].sort(
      (a, b) => new Date(a.deleted_at) - new Date(b.deleted_at)
    );
    for (const row of oldestFirst) {
      if (overage <= 0) break;
      ids.push(row.id);
      overage -= row.size_bytes || 0;
    }
  }
  return ids;
}

async function fetchByteSnapshot(c) {
  const { data, error } = await c.from(TABLE).select('id, user_id, size_bytes, deleted_at');
  if (error) throw new InboxPurgeError(`byte-pressure snapshot fetch failed: ${error.code || error.message}`);
  return data || [];
}

export async function runInboxPurge(deps = {}) {
  const c = client(deps);
  const now = deps.now || Date.now;

  const tombstoneIds = await fetchTombstoneAgeCandidateIds(c, now());
  const hardDeleted = await hardDeleteTombstonedIds(c, tombstoneIds);

  const rows = await fetchByteSnapshot(c);
  const pressureIds = selectPressureDeletionIds(rows);
  const pressureDeleted = await hardDeleteTombstonedIds(c, pressureIds);

  return { ok: true, hardDeleted, pressureDeleted };
}
