// lib/premiumRepo.js
// Service-role access to user_premium_feeds (spec §3.2). The url column is
// custody-bound: it may return ONLY from getOwnedFeedsWithUrls, whose callers
// must never serialize it into a response, log, or error.
import { getAdminClient } from './supabaseAdmin.js';

const MASKED_COLUMNS = 'id, label, kind, category, host_hint, created_at';

export class PremiumCapError extends Error {}
export class PremiumDuplicateError extends Error {}

function masked(row) {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    category: row.category,
    hostHint: row.host_hint,
    createdAt: row.created_at,
  };
}

function client(deps) {
  return deps.client || getAdminClient();
}

export async function listFeeds(userId, deps = {}) {
  const { data, error } = await client(deps)
    .from('user_premium_feeds')
    .select(MASKED_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`premium list failed: ${error.code || error.message}`);
  return (data || []).map(masked);
}

export async function getOwnedFeedsWithUrls(userId, ids, deps = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { data, error } = await client(deps)
    .from('user_premium_feeds')
    .select('id, url, label, kind, category, host_hint')
    .eq('user_id', userId)
    .in('id', ids);
  if (error) throw new Error(`premium resolve failed: ${error.code || error.message}`);
  return (data || []).map((r) => ({
    id: r.id, url: r.url, label: r.label, kind: r.kind, category: r.category, hostHint: r.host_hint,
  }));
}

export async function countFeeds(userId, deps = {}) {
  const { count, error } = await client(deps)
    .from('user_premium_feeds')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw new Error(`premium count failed: ${error.code || error.message}`);
  return count || 0;
}

export async function findByUrl(userId, url, deps = {}) {
  const { data, error } = await client(deps)
    .from('user_premium_feeds')
    .select('id')
    .eq('user_id', userId)
    .eq('url', url)
    .maybeSingle();
  if (error) throw new Error(`premium lookup failed: ${error.code || error.message}`);
  return data ? { id: data.id } : null;
}

export async function insertFeed({ userId, url, label, kind, category, hostHint }, deps = {}) {
  const { data, error } = await client(deps)
    .from('user_premium_feeds')
    .insert({ user_id: userId, url, label, kind, category, host_hint: hostHint })
    .select(MASKED_COLUMNS)
    .single();
  if (error) {
    if (error.code === 'P0001') throw new PremiumCapError('cap reached');
    if (error.code === '23505') throw new PremiumDuplicateError('duplicate url');
    throw new Error(`premium insert failed: ${error.code || 'unknown'}`);
  }
  return masked(data);
}

export async function updateFeedMeta(userId, id, { label, kind, category }, deps = {}) {
  const patch = {};
  if (label !== undefined) patch.label = label;
  if (kind !== undefined) patch.kind = kind;
  if (category !== undefined) patch.category = category;
  if (Object.keys(patch).length === 0) return null;
  const { data, error } = await client(deps)
    .from('user_premium_feeds')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', id)
    .select(MASKED_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`premium update failed: ${error.code || error.message}`);
  return data ? masked(data) : null;
}

export async function deleteFeed(userId, id, deps = {}) {
  const { data, error } = await client(deps)
    .from('user_premium_feeds')
    .delete()
    .eq('user_id', userId)
    .eq('id', id)
    .select('id');
  if (error) throw new Error(`premium delete failed: ${error.code || error.message}`);
  return (data || []).length > 0;
}
