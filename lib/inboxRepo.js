// lib/inboxRepo.js — service-role data access for the newsletter inbox
// (spec §4). Insert-only for messages: the DB has a no-undelete trigger that
// binds service_role too, so this file must never use
// `ON CONFLICT DO UPDATE SET deleted_at = null` or any upsert that could
// resurrect a tombstoned row. insertMessage is a single plain INSERT;
// duplicates (dedupe-key collisions) are detected, never overwritten.
import { getAdminClient } from './supabaseAdmin.js';
import { generateSlug } from './ingestSlug.js';

const MAX_SLUG_ATTEMPTS = 3;

export class InboxRepoError extends Error {}

function client(deps) {
  return deps.client || getAdminClient();
}

const ADDRESS_COLUMNS = 'id, user_id, slug, over_quota_since, deferred_count, last_deferred_at, created_at';

function addressRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    overQuotaSince: row.over_quota_since,
    deferredCount: row.deferred_count,
    lastDeferredAt: row.last_deferred_at,
    createdAt: row.created_at,
  };
}

// Attempts `attemptFn(slug)` with a freshly generated slug, retrying up to
// MAX_SLUG_ATTEMPTS times when the write collides on the slug's unique
// constraint (23505). Any other DB error throws immediately without retry.
// Used by rotateSlug, whose UPDATE is already scoped to a single existing
// row (no "does the row exist yet" ambiguity, so no re-select is needed).
async function withSlugRetry(operationLabel, attemptFn) {
  let lastError;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug();
    const { data, error } = await attemptFn(slug);
    if (!error) return data;
    if (error.code !== '23505') {
      throw new InboxRepoError(`${operationLabel} failed: ${error.code || error.message}`);
    }
    lastError = error;
  }
  throw new InboxRepoError(
    `${operationLabel} failed: slug retries exhausted (${lastError.code || lastError.message})`
  );
}

export async function findAddressBySlug(slug, deps = {}) {
  const { data, error } = await client(deps)
    .from('user_ingest_addresses')
    .select('id, user_id, over_quota_since')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new InboxRepoError(`find address by slug failed: ${error.code || error.message}`);
  return data ? { id: data.id, userId: data.user_id, overQuotaSince: data.over_quota_since } : null;
}

export async function getAddressRow(userId, deps = {}) {
  const { data, error } = await client(deps)
    .from('user_ingest_addresses')
    .select(ADDRESS_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new InboxRepoError(`get address row failed: ${error.code || error.message}`);
  return data ? addressRow(data) : null;
}

// Row exists but its slug is null: claim it with a WHERE-guarded UPDATE
// (`... WHERE slug IS NULL`, expressed via `.is('slug', null)`) — never an
// unguarded write. A null result (zero rows matched) means a concurrent
// caller's UPDATE already claimed this row first; re-select and return
// their row instead of retrying (retrying here would just keep matching
// zero rows forever, since the slug is no longer null).
async function claimNullSlug(userId, deps) {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug();
    const { data, error } = await client(deps)
      .from('user_ingest_addresses')
      .update({ slug })
      .eq('user_id', userId)
      .is('slug', null)
      .select(ADDRESS_COLUMNS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') continue; // slug already held by a different user, retry
      throw new InboxRepoError(`ensure address failed: ${error.code || error.message}`);
    }
    if (data) return addressRow(data);
    const winner = await getAddressRow(userId, deps);
    if (winner) return winner;
    throw new InboxRepoError('ensure address failed: concurrent claim winner not found on re-select');
  }
  throw new InboxRepoError('ensure address failed: slug retries exhausted');
}

// No row exists yet: plain INSERT (never an upsert). A unique-violation
// (23505) is ambiguous between two different constraints — user_id or
// slug — so it's disambiguated the way the plan specifies: re-select
// settles it. A row found means a concurrent insert won the user_id race
// (return the winner, don't retry — a fresh slug can't resolve a user_id
// collision). No row found means it was a slug collision with a different
// user's address — retry with a fresh slug.
async function insertAddress(userId, deps) {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug();
    const { data, error } = await client(deps)
      .from('user_ingest_addresses')
      .insert({ user_id: userId, slug })
      .select(ADDRESS_COLUMNS)
      .single();
    if (!error) return addressRow(data);
    if (error.code !== '23505') {
      throw new InboxRepoError(`ensure address failed: ${error.code || error.message}`);
    }
    const winner = await getAddressRow(userId, deps);
    if (winner) return winner;
    // else: still no row for this user — the collision was on the slug
    // constraint, not user_id. Fall through and retry with a fresh slug.
  }
  throw new InboxRepoError('ensure address failed: slug retries exhausted');
}

// Idempotent AND race-free (plan §T6): two concurrent calls for the same
// user must both end up returning the single slug the DB actually holds —
// never an unguarded upsert that could let one caller's write silently
// clobber another's already-issued slug.
export async function ensureAddress(userId, deps = {}) {
  const existing = await getAddressRow(userId, deps);
  if (existing && existing.slug) return existing;
  if (existing) return claimNullSlug(userId, deps);
  return insertAddress(userId, deps);
}

export async function rotateSlug(userId, deps = {}) {
  const row = await withSlugRetry('rotate slug', (slug) =>
    client(deps)
      .from('user_ingest_addresses')
      .update({ slug })
      .eq('user_id', userId)
      .select(ADDRESS_COLUMNS)
      .single()
  );
  return addressRow(row);
}

export async function disableSlug(userId, deps = {}) {
  const { error } = await client(deps)
    .from('user_ingest_addresses')
    .update({ slug: null })
    .eq('user_id', userId);
  if (error) throw new InboxRepoError(`disable slug failed: ${error.code || error.message}`);
}

// Two round trips (count(head) + a size_bytes select summed client-side) —
// PostgREST cannot express sum(size_bytes) via the query builder without a
// schema-defined RPC. Both scope to live rows (deleted_at IS NULL), matching
// the quota trigger's own definition of "live" in the Task 1 migration.
export async function quotaSnapshot(userId, deps = {}) {
  const c = client(deps);
  const { count, error: countError } = await c
    .from('user_inbox_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (countError) {
    throw new InboxRepoError(`quota snapshot count failed: ${countError.code || countError.message}`);
  }

  const { data, error: sumError } = await c
    .from('user_inbox_messages')
    .select('size_bytes')
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (sumError) {
    throw new InboxRepoError(`quota snapshot sum failed: ${sumError.code || sumError.message}`);
  }

  const bytesUsed = (data || []).reduce((sum, row) => sum + (row.size_bytes || 0), 0);
  return { messageCount: count || 0, bytesUsed };
}

function toMessageRow(row) {
  return {
    user_id: row.userId,
    from_email: row.fromEmail,
    from_name: row.fromName ?? null,
    subject: row.subject ?? '',
    html_body: row.html ?? null,
    text_body: row.text ?? null,
    excerpt: row.excerpt ?? null,
    size_bytes: row.sizeBytes,
    web_url: row.webUrl ?? null,
    unsubscribe_url: row.unsubscribeUrl ?? null,
    auth_results: row.authResults ?? null,
    dedupe_key: row.dedupeKey,
    message_id: row.messageId ?? null,
  };
}

// Single plain INSERT — never an upsert (see file header: the no-undelete
// trigger forbids resurrecting a tombstoned row, and service_role is bound
// by it too). A dedupe-key collision (23505) means "drop as duplicate",
// never "overwrite". P0001 is shared by two different triggers on this
// table (quota + no-undelete), so the quota verdict is disambiguated by
// message text, not error code.
export async function insertMessage(row, deps = {}) {
  const { error } = await client(deps).from('user_inbox_messages').insert(toMessageRow(row));
  if (!error) return 'inserted';
  if (error.code === '23505') return 'duplicate';
  if (/inbox quota exceeded/i.test(error.message || '')) return 'over_quota';
  throw new InboxRepoError(`insert message failed: ${error.code || error.message}`);
}

// Marks a defer event: over_quota_since is set only the first time (never
// overwritten while still set), deferred_count increments, last_deferred_at
// always advances to now. Two round trips (read current counters, then
// write) — the query builder cannot express a set-if-null UPDATE.
export async function markDeferred(userId, deps = {}) {
  const c = client(deps);
  const { data, error: selectError } = await c
    .from('user_ingest_addresses')
    .select('over_quota_since, deferred_count')
    .eq('user_id', userId)
    .maybeSingle();
  if (selectError) {
    throw new InboxRepoError(`mark deferred lookup failed: ${selectError.code || selectError.message}`);
  }

  const nowIso = new Date().toISOString();
  const patch = {
    over_quota_since: (data && data.over_quota_since) || nowIso,
    deferred_count: ((data && data.deferred_count) || 0) + 1,
    last_deferred_at: nowIso,
  };
  const { error: updateError } = await c
    .from('user_ingest_addresses')
    .update(patch)
    .eq('user_id', userId);
  if (updateError) {
    throw new InboxRepoError(`mark deferred update failed: ${updateError.code || updateError.message}`);
  }
}

export async function clearDeferred(userId, deps = {}) {
  const { error } = await client(deps)
    .from('user_ingest_addresses')
    .update({ over_quota_since: null })
    .eq('user_id', userId);
  if (error) throw new InboxRepoError(`clear deferred failed: ${error.code || error.message}`);
}
