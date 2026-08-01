// lib/inboxPurge.js — the ONLY component in Phase 3 permitted to hard-delete
// user_inbox_messages rows, and only tombstoned ones (spec §5.3). Deletes
// elsewhere in the app are soft (deleted_at tombstones); this cron is where
// tombstones actually leave the table, so every delete's filter chain
// re-asserts `deleted_at is not null` even though the other predicates in
// the same chain already make a live row unreachable — belt and braces, a
// live row must be unreachable by construction (landmine 11: check {error}
// on every call).
//
// Two passes:
//   (a) hard-delete tombstones older than 30 days, via TWO DIRECT FILTERED
//       DELETES (repo precedent: lib/articlesWrite.js's prune()) — no id
//       prefetch. supabase-js can't express `least(deleted_at, now())`, and
//       an id-prefetch-then-`.in()` shape was tried and rejected: a SELECT
//       is capped at the project's PostgREST max-rows (Supabase default
//       1000) with `error: null`, silently under-collecting ids past that
//       cap, and a 500-id `.in()` URL runs ~18.5KB — past typical request-
//       line ceilings, so the batch itself 414s. Direct filtered deletes
//       have neither failure mode: the WHERE clause runs entirely in
//       Postgres, no id list ever crosses the wire.
//         - normal path: `deleted_at < now() - 30d`.
//         - future-dated-`deleted_at` path: `deleted_at > now()` AND
//           `received_at < now() - 30d`. This is NOT a second, later grace
//           period layered on top of the tombstone date — a row qualifies
//           here the instant its `received_at` alone is >30 days old,
//           regardless of when (or how far in the future) it was
//           tombstoned. That's deliberate: without it, stamping a future
//           `deleted_at` would dodge the purge forever; the tradeoff is
//           that a message tombstoned today with a buggy/future
//           `deleted_at`, but already old by `received_at`, is hard-deleted
//           on the very next run, not 30 days from now.
//   (b) byte pressure: for a user whose TOTAL bytes (live + tombstoned)
//       exceed 2x MAX_LIVE_BYTES, hard-delete their oldest tombstones until
//       back under — live rows are never eligible, they only count toward
//       the total. Runs after pass (a), over the post-pass-(a) state. The
//       snapshot that totals are computed from is fetched with DETERMINISTIC
//       PAGINATION (`.order('id').range()`, looping until a short page) —
//       the same PostgREST max-rows cap that broke the pass-(a) id prefetch
//       would otherwise silently truncate this snapshot too, under-counting
//       a user's true total and leaving them permanently under the
//       pressure cap no matter how much they actually hold. Deletes for
//       this pass still batch ids via `.in()` (the ids selected here are
//       already tombstone-scoped, unlike a full-table prefetch), but at
//       <=100 per batch — comfortably under URL length limits for UUID
//       lists.
import { getAdminClient } from './supabaseAdmin.js';
import { MAX_LIVE_BYTES } from './inboxConfig.js';

export class InboxPurgeError extends Error {}

const TABLE = 'user_inbox_messages';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const PRESSURE_DELETE_BATCH_SIZE = 100;
export const SNAPSHOT_PAGE_SIZE = 1000;
const PRESSURE_THRESHOLD_BYTES = 2 * MAX_LIVE_BYTES;

function client(deps) {
  return deps.client || getAdminClient();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Pass (a): two direct filtered deletes, no id prefetch (see file header for
// why). `deleted_at < cutoff` and `deleted_at > now` both naturally exclude
// live rows (deleted_at IS NULL fails every comparison), so `.not('deleted_at',
// 'is', null)` on each is belt-and-braces, not the only guard.
export async function purgeAgedTombstones(c, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - THIRTY_DAYS_MS).toISOString();

  const { error: agedError, count: agedCount } = await c
    .from(TABLE)
    .delete({ count: 'exact' })
    .lt('deleted_at', cutoffIso)
    .not('deleted_at', 'is', null);
  if (agedError) {
    throw new InboxPurgeError(`aged-tombstone delete failed: ${agedError.code || agedError.message}`);
  }

  const { error: futureError, count: futureCount } = await c
    .from(TABLE)
    .delete({ count: 'exact' })
    .gt('deleted_at', nowIso)
    .lt('received_at', cutoffIso)
    .not('deleted_at', 'is', null);
  if (futureError) {
    throw new InboxPurgeError(`future-dated tombstone delete failed: ${futureError.code || futureError.message}`);
  }

  return (agedCount ?? 0) + (futureCount ?? 0);
}

// Fetches the whole table (id/user_id/size_bytes/deleted_at) for pass (b)'s
// per-user totals, paginated with `.order('id').range()` so the project's
// PostgREST max-rows cap (Supabase default 1000, silent, `error: null`)
// cannot truncate the snapshot — it loops until a page comes back shorter
// than requested, which is also true the moment the table is exhausted.
export async function fetchByteSnapshot(c) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await c
      .from(TABLE)
      .select('id, user_id, size_bytes, deleted_at')
      .order('id')
      .range(from, from + SNAPSHOT_PAGE_SIZE - 1);
    if (error) {
      throw new InboxPurgeError(`byte-pressure snapshot fetch failed: ${error.code || error.message}`);
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < SNAPSHOT_PAGE_SIZE) break;
    from += SNAPSHOT_PAGE_SIZE;
  }
  return rows;
}

// Batched hard-delete for pass (b), <=100 ids per `.in()` — a 500-id UUID
// list runs long enough to risk a 414 against typical request-line
// ceilings, so this stays well under that. `{ error }` is checked per
// batch (landmine 11), and this throws on the FIRST batch that errors:
// remaining batches are never attempted, and the running `deleted` count
// is discarded — the caller only sees the throw. Batches that already
// succeeded earlier in the same call are NOT rolled back (their deletes
// already landed), but the function still reports failure so runInboxPurge
// (and the cron route) fails loud rather than returning a count that looks
// like the whole run succeeded.
export async function hardDeleteTombstonedIds(c, ids) {
  let deleted = 0;
  for (const batch of chunk(ids, PRESSURE_DELETE_BATCH_SIZE)) {
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

export async function runInboxPurge(deps = {}) {
  const c = client(deps);
  const now = deps.now || Date.now;

  const hardDeleted = await purgeAgedTombstones(c, now());

  const rows = await fetchByteSnapshot(c);
  const pressureIds = selectPressureDeletionIds(rows);
  const pressureDeleted = await hardDeleteTombstonedIds(c, pressureIds);

  return { ok: true, hardDeleted, pressureDeleted };
}
