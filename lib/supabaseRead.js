import { createClient } from '@supabase/supabase-js';

// Server-side anon READ client. Reads non-VITE_ env only: the `VITE_` prefix
// means safe-for-browser, and server code never reads VITE_ names (spec §6).
let client;

export function getReadClient() {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  client =
    url && key
      ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
      : null; // unset env (e.g. bare dev): store reads unavailable, callers fall back live
  return client;
}

export function resetReadClientForTests() {
  client = undefined;
}
