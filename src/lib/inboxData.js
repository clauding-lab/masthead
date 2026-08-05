// src/lib/inboxData.js — browser-side inbox reads/writes, all under the
// owner's own RLS via `supabase` from ./supabase (never the admin client;
// there is no admin client in the browser bundle). `authenticated` holds
// SELECT on every column but UPDATE on ONLY (read_at, deleted_at)
// (20260731_create_inbox.sql) — every write here touches those two columns
// and nothing else. Removal is always a `deleted_at` tombstone (landmine
// 23/25: there is no DELETE grant, and a no-undelete trigger forbids
// resurrecting one) — this file must never call `.delete()`.
//
// `supabase` is `null` when VITE_SUPABASE_URL/ANON_KEY are unset
// (src/lib/supabase.js) — every function guards with `if (!supabase) return
// ...` up front, matching the sibling idiom in src/lib/sync.js,
// src/lib/premiumApi.js, and src/stores/authStore.js.
import { supabase } from './supabase';

const TABLE = 'user_inbox_messages';

// Metadata only — NEVER html_body/text_body. Those are the two columns the
// inbox list view has no business reading; getMessage is the only place
// bodies leave the DB.
const LIST_COLUMNS =
  'id, from_email, from_name, subject, excerpt, received_at, read_at, web_url, unsubscribe_url, auth_results, size_bytes';

/**
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listMessages({ limit = 100 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select(LIST_COLUMNS)
    .is('deleted_at', null)
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getMessage(id) {
  if (!supabase) return null;
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function markRead(id) {
  if (!supabase) return;
  const { error } = await supabase
    .from(TABLE)
    .update({ read_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// Tombstone, never a row delete — see file header. Also filters
// `deleted_at IS NULL` so re-removing an already-tombstoned row is a no-op:
// without it, calling this twice would push `deleted_at` forward each time,
// resetting the 30-day purge clock (`lib/inboxPurge.js`) indefinitely.
/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function removeMessage(id) {
  if (!supabase) return;
  const { error } = await supabase
    .from(TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null);
  if (error) throw error;
}

// Tombstones every already-read, still-live message in one UPDATE — never a
// row delete (see file header).
/**
 * @returns {Promise<void>}
 */
export async function clearRead() {
  if (!supabase) return;
  const { error } = await supabase
    .from(TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .not('read_at', 'is', null)
    .is('deleted_at', null);
  if (error) throw error;
}

/**
 * @returns {Promise<number>}
 */
export async function unreadCount() {
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)
    .is('deleted_at', null);
  if (error) throw error;
  return count || 0;
}
