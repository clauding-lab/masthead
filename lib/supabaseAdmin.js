import { createClient } from '@supabase/supabase-js';

// Service-role client. lib/articlesWrite.js is the ONLY permitted importer;
// lib/securityBoundary.test.js enforces the boundary.
if (typeof window !== 'undefined') {
  throw new Error('lib/supabaseAdmin.js must never be imported in browser code');
}

let client;

export function getAdminClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // Write path fails loud (poller surfaces 503) instead of silently no-oping.
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the write path');
  }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
