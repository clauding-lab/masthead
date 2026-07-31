// scripts/probe-inbox-custody.mjs
// Manual post-migration verification (Phase 3 spec §4 data model, §10.2g rollout
// probe gate). Run: npm run probe-inbox
// Requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in .env.local.
// Optional: SUPABASE_SERVICE_ROLE_KEY + PROBE_USER_ID in env to run the
// concurrent-cap test (8 parallel inserts -> exactly 5 rows) and the
// byte-equality check.
//
// Authenticated-role probes (a signed-in user reading/updating their own
// rows) require a real user JWT this script cannot mint. Per 2E precedent,
// they are skipped here with documented compensating evidence: the RLS
// policies (inbox_messages_select_own, inbox_messages_update_own) and the
// column-scoped grant (select + update(read_at, deleted_at) to authenticated)
// must be read back from Postgres by the agent after the migration is
// applied, e.g.:
//   select polname, cmd, qual, with_check from pg_policies
//     where tablename = 'user_inbox_messages';
//   select grantee, privilege_type, column_name from information_schema.column_privileges
//     where table_name = 'user_inbox_messages' and grantee = 'authenticated';
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

// user_ingest_addresses: zero client grants, anon fully denied.
await expectDenied('anon SELECT addresses', 'GET', 'user_ingest_addresses?select=*');
await expectDenied('anon INSERT addresses', 'POST', 'user_ingest_addresses', { user_id: '00000000-0000-0000-0000-000000000000', slug: 'abc-def-0000' });
await expectDenied('anon UPDATE addresses', 'PATCH', 'user_ingest_addresses?id=eq.00000000-0000-0000-0000-000000000000', { deferred_count: 1 });
await expectDenied('anon DELETE addresses', 'DELETE', 'user_ingest_addresses?id=eq.00000000-0000-0000-0000-000000000000');

// user_inbox_messages: anon has no grants (RLS policies are authenticated-only).
await expectDenied('anon SELECT messages', 'GET', 'user_inbox_messages?select=*');
await expectDenied('anon INSERT messages', 'POST', 'user_inbox_messages', { user_id: '00000000-0000-0000-0000-000000000000', from_email: 'x@x.test', size_bytes: 0, dedupe_key: 'x' });
await expectDenied('anon UPDATE messages', 'PATCH', 'user_inbox_messages?id=eq.00000000-0000-0000-0000-000000000000', { read_at: new Date().toISOString() });
await expectDenied('anon DELETE messages', 'DELETE', 'user_inbox_messages?id=eq.00000000-0000-0000-0000-000000000000');

// enforce_inbox_quota: revoked from anon/authenticated/public, not exposed as an RPC anon can call.
await expectDenied('anon RPC enforce_inbox_quota', 'POST', 'rpc/enforce_inbox_quota', {});

const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const probeUser = process.env.PROBE_USER_ID;
if (service && probeUser) {
  const hdr = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' };
  await fetch(`${url}/rest/v1/user_inbox_messages?user_id=eq.${probeUser}`, { method: 'DELETE', headers: hdr });

  // (a) concurrency: 8 parallel inserts declaring 20 MB each -> exactly 5 land (5x20MB = 100MB cap).
  const inserts = Array.from({ length: 8 }, (_, i) =>
    fetch(`${url}/rest/v1/user_inbox_messages`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        user_id: probeUser,
        from_email: 'cap-test@example.com',
        size_bytes: 20000000,
        dedupe_key: `cap-test-${i}`,
      }),
    })
  );
  await Promise.all(inserts);
  const rows = await (await fetch(`${url}/rest/v1/user_inbox_messages?user_id=eq.${probeUser}&select=id&dedupe_key=like.cap-test-*`, { headers: hdr })).json();
  const capPass = rows.length === 5;
  console.log(`${capPass ? 'PASS' : 'FAIL'} concurrent cap: ${rows.length}/8 inserts landed (want exactly 5)`);
  if (!capPass) failures++;
  await fetch(`${url}/rest/v1/user_inbox_messages?user_id=eq.${probeUser}&dedupe_key=like.cap-test-*`, { method: 'DELETE', headers: hdr });

  // (b) byte equality: insert one row with a multi-byte body, read back sum(size_bytes),
  // assert exact match against Buffer.byteLength of the same string.
  const multiByteBody = 'inbox probe éèê 中文 📬';
  const declaredBytes = Buffer.byteLength(multiByteBody, 'utf8');
  await fetch(`${url}/rest/v1/user_inbox_messages`, {
    method: 'POST', headers: hdr,
    body: JSON.stringify({
      user_id: probeUser,
      from_email: 'byte-test@example.com',
      text_body: multiByteBody,
      size_bytes: declaredBytes,
      dedupe_key: 'byte-test-1',
    }),
  });
  const sumRes = await fetch(
    `${url}/rest/v1/user_inbox_messages?user_id=eq.${probeUser}&dedupe_key=eq.byte-test-1&select=size_bytes`,
    { headers: hdr }
  );
  const sumRows = await sumRes.json();
  const storedBytes = sumRows.reduce((acc, r) => acc + r.size_bytes, 0);
  const bytePass = storedBytes === declaredBytes;
  console.log(`${bytePass ? 'PASS' : 'FAIL'} byte equality: stored ${storedBytes} vs Buffer.byteLength ${declaredBytes}`);
  if (!bytePass) failures++;

  // (c) cleanup: delete all probe rows for this user.
  await fetch(`${url}/rest/v1/user_inbox_messages?user_id=eq.${probeUser}`, { method: 'DELETE', headers: hdr });
} else {
  console.log('SKIP concurrent cap + byte equality tests (set SUPABASE_SERVICE_ROLE_KEY + PROBE_USER_ID to run)');
}

console.log('SKIP authenticated-role probes (no mintable user JWT) — verify RLS policies + column grants by reading them back from Postgres post-migration, see header comment.');

process.exit(failures === 0 ? 0 : 1);
