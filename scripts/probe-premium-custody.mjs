// scripts/probe-premium-custody.mjs
// Manual post-migration verification (spec §3.2/§7). Run: npm run probe-premium
// Requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in .env.local.
// Optional: SUPABASE_SERVICE_ROLE_KEY + PROBE_USER_ID in env to run the
// concurrent-cap test (8 parallel inserts -> exactly 5 rows).
import { readFileSync } from 'node:fs';

function env(name) {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const line = readFileSync('.env.local', 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : null;
}

const url = env('VITE_SUPABASE_URL');
const anon = env('VITE_SUPABASE_ANON_KEY');
if (!url || !anon) { console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY'); process.exit(1); }

let failures = 0;
async function expectDenied(label, method, path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Denied = 401/403/404, or 200 with an empty array (RLS row-filtered SELECT).
  const denied = res.status >= 400 || text.trim() === '[]';
  console.log(`${denied ? 'PASS' : 'FAIL'} ${label}: ${res.status} ${text.slice(0, 80)}`);
  if (!denied) failures++;
}

await expectDenied('anon SELECT', 'GET', 'user_premium_feeds?select=*');
await expectDenied('anon INSERT', 'POST', 'user_premium_feeds', { user_id: '00000000-0000-0000-0000-000000000000', url: 'https://x.test/f', label: 'x', kind: 'news', host_hint: 'x.test' });
await expectDenied('anon UPDATE', 'PATCH', 'user_premium_feeds?id=eq.00000000-0000-0000-0000-000000000000', { label: 'y' });
await expectDenied('anon DELETE', 'DELETE', 'user_premium_feeds?id=eq.00000000-0000-0000-0000-000000000000');

const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const probeUser = process.env.PROBE_USER_ID;
if (service && probeUser) {
  const hdr = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' };
  await fetch(`${url}/rest/v1/user_premium_feeds?user_id=eq.${probeUser}`, { method: 'DELETE', headers: hdr });
  const inserts = Array.from({ length: 8 }, (_, i) =>
    fetch(`${url}/rest/v1/user_premium_feeds`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ user_id: probeUser, url: `https://cap-test.example.com/feed-${i}`, label: `cap ${i}`, kind: 'news', host_hint: 'example.com' }),
    })
  );
  await Promise.all(inserts);
  const rows = await (await fetch(`${url}/rest/v1/user_premium_feeds?user_id=eq.${probeUser}&select=id`, { headers: hdr })).json();
  const pass = rows.length === 5;
  console.log(`${pass ? 'PASS' : 'FAIL'} concurrent cap: ${rows.length}/8 inserts landed (want exactly 5)`);
  if (!pass) failures++;
  await fetch(`${url}/rest/v1/user_premium_feeds?user_id=eq.${probeUser}`, { method: 'DELETE', headers: hdr });
} else {
  console.log('SKIP concurrent cap test (set SUPABASE_SERVICE_ROLE_KEY + PROBE_USER_ID to run)');
}

process.exit(failures === 0 ? 0 : 1);
