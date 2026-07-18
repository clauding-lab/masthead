# Phase 2 · Slice 2E — Premium Subscriber Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in users register up to 5 secret-bearing subscriber feed URLs held in server custody; articles surface by kind with live fetch, token redaction, and zero storage of premium content.

**Architecture:** One service-role-only table (`user_premium_feeds`) reachable only through authenticated API routes; `/api/feeds` gains optional auth and merges premium live fetches (3s timeout, 90s single-flight TTL cache) into the existing custom pipeline; the client gains a premium store, per-kind id selection, and a body-on-demand reader path. Spec: `docs/superpowers/specs/2026-07-18-phase2-2e-premium-feeds-design.md` (post-red-team revision `98e9c95`).

**Tech Stack:** React 19 + Vite PWA, Zustand, Vercel serverless (`api/*.mjs`), Supabase (Postgres + Auth), rss-parser, sanitize-html, vitest, `tldts` (new, server-only).

## Global Constraints

- Secret custody: the feed URL never appears in any response after add, any GET query string, any log line, or any error message (spec §4.3). Premium fetch errors log **row id + host_hint only**.
- Auth is fail-closed: ANY failure inside token verification → 401 (spec §4.1). Never copy `lib/rateLimit.js`'s fail-open pattern.
- Zero premium content persisted server-side. The cron, `articles` store, `lib/sources.json`, and public catalog are untouched.
- Constants (locked): `MAX_PREMIUM_FEEDS = 5`, `MAX_PREMIUM_IDS = 10`, `PREMIUM_TIMEOUT_MS = 3000`, `PREMIUM_CACHE_TTL_MS = 90_000`, `MAX_BODY_CHARS = 500_000`.
- `kind` ∈ `news | blog` only for premium (no social). `category` defaults to `custom`.
- Anti-oracle: all add-time validation failures return one generic 422 `{ error: 'Could not validate feed URL' }`. Only non-remote-revealing errors differ: `http://` → 400, cap → 403, dupe → 409.
- Real-fixture rule (AGENTS.md landmine 15): parser/redaction tests use a real captured full-content RSS fixture carrying a token, not hand-built XML.
- House rules: TDD every task; `mv` to scratchpad not `rm`; conventional commits; never push main; tests via `npm test` (vitest; baseline 194 passing), single file via `npx vitest run <path>`; eslint baseline is 4 errors + 5 warnings — zero new.
- `lib/supabaseAdmin.js` importer allowlist is enforced by `lib/securityBoundary.test.js` — every new importer is added there deliberately (Tasks 2, 4).

## File Structure

```
supabase/migrations/20260719_create_user_premium_feeds.sql   (new — table, trigger, revokes)
scripts/probe-premium-custody.mjs                            (new — manual post-migration probes)
lib/authVerify.js            (new — shared fail-closed JWT verifier)
lib/hostHint.js              (new — registrable-domain derivation, tldts)
lib/premiumRedact.js         (new — secret-component extraction + redaction)
lib/premiumRepo.js           (new — service-role CRUD for user_premium_feeds)
lib/premiumService.js        (new — validate/resolve/fetch/cache/body orchestration)
lib/feedParser.js            (modify — export fetchRawItems)
lib/feedService.js           (modify — premium merge in getHeadlinesForSources)
api/premium-feeds.mjs        (new — authed management + body route)
api/feeds.mjs                (modify — optional auth + premiumIds)
vercel.json                  (modify — functions entry)
src/lib/premiumApi.js        (new — authed client calls)
src/stores/premiumStore.js   (new — masked list + enabled ids + reconciliation)
src/lib/api.js               (modify — premiumIds + Authorization on POST /api/feeds)
src/stores/feedStore.js      (modify — guard + premiumIds + auth-retry + premiumIssues)
src/stores/authStore.js      (modify — sign-out sweep extension)
src/stores/articleStore.js   (modify — fetchPremiumArticle)
src/components/AddSourceModal.jsx      (modify — premium path + autofill hardening)
src/components/PremiumSourceRow.jsx    (new — Settings row: lock badge, toggle, edit, delete)
src/pages/SettingsPage.jsx   (modify — premium rows per kind group)
src/pages/ReaderPage.jsx     (modify — premium body path)
src/components/HeadlineCard.jsx        (modify — pass premium fields in nav state)
src/pages/FeedLayout.jsx     (modify — premium failure banner)
src/lib/library.js           (modify — premium body branch on save)
AGENTS.md                    (modify — landmine 16 amendment, ship-time)
```

---

### Task 1: Migration + custody probe script

**Files:**
- Create: `supabase/migrations/20260719_create_user_premium_feeds.sql`
- Create: `scripts/probe-premium-custody.mjs`
- Modify: `package.json` (script entry)

**Interfaces:**
- Produces: table `public.user_premium_feeds` (columns per spec §3.1); DB-enforced 5-cap via trigger `enforce_premium_feed_cap`; zero grants to anon/authenticated/PUBLIC.
- The probe script is manual (network, real project) — NOT part of `npm test`.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 2 Slice 2E: per-user premium subscriber feeds (spec §3).
-- SERVICE-ROLE-ONLY custody: zero client grants; url never crosses PostgREST.
create table public.user_premium_feeds (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  url         text not null check (url ~* '^https://'),
  label       text not null check (length(label) <= 200),
  kind        text not null check (kind in ('news', 'blog')),
  category    text not null default 'custom' check (length(category) <= 50),
  host_hint   text not null check (length(host_hint) <= 300),
  created_at  timestamptz not null default now(),
  constraint user_premium_feeds_unique_url unique (user_id, url),
  constraint sane_url_size check (length(url) <= 4000)
);

create index user_premium_feeds_user_idx on public.user_premium_feeds (user_id);

-- DB-enforced cap (spec §3.1): check-then-insert in the API is a TOCTOU race;
-- the 5th-vs-6th decision belongs to Postgres. The per-user advisory lock
-- serializes concurrent inserts for the same user.
create or replace function public.enforce_premium_feed_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('premium_cap'), hashtext(new.user_id::text));
  if (select count(*) from public.user_premium_feeds where user_id = new.user_id) >= 5 then
    raise exception 'premium feed cap reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger user_premium_feeds_cap
  before insert on public.user_premium_feeds
  for each row execute function public.enforce_premium_feed_cap();

-- Custody: RLS on with NO policies (defense in depth) + explicit zero grants.
-- Revoke from PUBLIC too — revoking only anon/authenticated is a no-op if the
-- grant came via PUBLIC (AGENT_LEARNINGS: revoke-PUBLIC gotcha).
alter table public.user_premium_feeds enable row level security;
revoke all on table public.user_premium_feeds from anon, authenticated, public;
revoke all on function public.enforce_premium_feed_cap() from anon, authenticated, public;
```

- [ ] **Step 2: Write the probe script**

```js
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
```

- [ ] **Step 3: Add the npm script** — in `package.json` `"scripts"`, add `"probe-premium": "node scripts/probe-premium-custody.mjs"`.

- [ ] **Step 4: Verify nothing broke** — Run: `npm test` → expected: 194 passing, exit 0 (nothing imports the new files yet).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260719_create_user_premium_feeds.sql scripts/probe-premium-custody.mjs package.json
git commit -m "feat(2e): user_premium_feeds migration with DB-enforced cap + custody probe script"
```

> Migration is APPLIED at Task 13 (rollout), not here — applying needs the linked project. The probe script is the proof-of-application gate.

---

### Task 2: `lib/authVerify.js` — shared fail-closed JWT verifier

**Files:**
- Create: `lib/authVerify.js`, `lib/authVerify.test.js`
- Modify: `lib/securityBoundary.test.js` (allowlist `lib/authVerify.js` as a permitted `supabaseAdmin` importer)

**Interfaces:**
- Produces: `AuthError` (class); `requireUser(req, deps?)` → `Promise<{ userId: string }>`, throws `AuthError` on ANY failure (missing header, malformed, invalid token, network error, verifier throw). `deps.getUser` injectable for tests.
- Consumed by: Tasks 7, 8 (routes map `AuthError` → 401).

- [ ] **Step 1: Write the failing tests**

```js
// lib/authVerify.test.js
import { describe, it, expect } from 'vitest';
import { requireUser, AuthError } from './authVerify.js';

const reqWith = (auth) => ({ headers: auth ? { authorization: auth } : {} });

describe('requireUser (fail-closed — spec §4.1)', () => {
  it('returns userId for a valid token', async () => {
    const getUser = async (token) => {
      expect(token).toBe('good-token');
      return { data: { user: { id: 'user-1' } }, error: null };
    };
    await expect(requireUser(reqWith('Bearer good-token'), { getUser })).resolves.toEqual({ userId: 'user-1' });
  });

  it.each([
    ['missing header', undefined],
    ['non-bearer header', 'Basic abc'],
    ['empty bearer', 'Bearer '],
  ])('throws AuthError on %s', async (_label, header) => {
    const getUser = async () => ({ data: { user: { id: 'u' } }, error: null });
    await expect(requireUser(reqWith(header), { getUser })).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError when Supabase reports an invalid token', async () => {
    const getUser = async () => ({ data: { user: null }, error: { message: 'invalid JWT' } });
    await expect(requireUser(reqWith('Bearer bad'), { getUser })).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError when the verifier itself throws (fail-closed, never fail-open)', async () => {
    const getUser = async () => { throw new Error('network down'); };
    await expect(requireUser(reqWith('Bearer any'), { getUser })).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError on a user object without an id', async () => {
    const getUser = async () => ({ data: { user: {} }, error: null });
    await expect(requireUser(reqWith('Bearer any'), { getUser })).rejects.toBeInstanceOf(AuthError);
  });
});
```

- [ ] **Step 2: Run to verify failure** — Run: `npx vitest run lib/authVerify.test.js` → expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// lib/authVerify.js
// Shared JWT verification for authenticated API routes (spec §4.1).
// FAIL-CLOSED: any failure of the verification step itself — network error,
// timeout, malformed token, thrown exception — is an AuthError (→ 401 at the
// route). This deliberately does NOT inherit lib/rateLimit.js's fail-open
// posture: that pattern is for abuse-mitigation availability, not identity.
import { getAdminClient } from './supabaseAdmin.js';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

function defaultGetUser(token) {
  return getAdminClient().auth.getUser(token);
}

export async function requireUser(req, { getUser = defaultGetUser } = {}) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  if (!header.startsWith('Bearer ')) throw new AuthError('Missing bearer token');
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new AuthError('Empty bearer token');
  try {
    const { data, error } = await getUser(token);
    if (error || !data?.user?.id) throw new AuthError('Invalid token');
    return { userId: data.user.id };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('Verification failed');
  }
}
```

- [ ] **Step 4: Update the security boundary test** — Read `lib/securityBoundary.test.js`; extend its permitted-importer list to include `lib/authVerify.js` (and adjust its assertion message). Keep the test failing for any OTHER new importer.

- [ ] **Step 5: Verify** — Run: `npx vitest run lib/authVerify.test.js lib/securityBoundary.test.js` → expected: PASS. Then `npm test` → 199 passing (194 + 5 new), exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/authVerify.js lib/authVerify.test.js lib/securityBoundary.test.js
git commit -m "feat(2e): shared fail-closed JWT verifier (requireUser)"
```

---

### Task 3: `lib/hostHint.js` + `lib/premiumRedact.js` — pure helpers

**Files:**
- Create: `lib/hostHint.js`, `lib/hostHint.test.js`, `lib/premiumRedact.js`, `lib/premiumRedact.test.js`
- Modify: `package.json` (+ `tldts` dependency)

**Interfaces:**
- Produces: `registrableDomain(urlString)` → `'theverge.com'` (eTLD+1; falls back to full hostname if tldts returns null); `secretParts(feedUrl)` → `string[]` (query values ≥ 8 chars + path segments ≥ 16 chars matching `/^[A-Za-z0-9_-]+$/`); `redactString(text, parts)` → text with each part replaced by `'redacted'`; `redactContentHtml(html, parts)` → html where any `<a href>` containing a part loses its href (text kept) and bare occurrences are replaced.
- Consumed by: Tasks 5, 6, 7.

- [ ] **Step 1: Install tldts** — Run: `npm install tldts` → expected: exit 0. (Server-only import — never from `src/`.)

- [ ] **Step 2: Write the failing tests**

```js
// lib/hostHint.test.js
import { describe, it, expect } from 'vitest';
import { registrableDomain } from './hostHint.js';

describe('registrableDomain (spec §3.1 — tokens can hide in subdomain labels)', () => {
  it('reduces a plain hostname to itself', () => {
    expect(registrableDomain('https://theverge.com/rss/full.xml')).toBe('theverge.com');
  });
  it('drops subdomain labels (token-bearing subdomains never reach the client)', () => {
    expect(registrableDomain('https://a8f3k2j9x7q1.feeds.example.com/rss')).toBe('example.com');
  });
  it('handles multi-part public suffixes', () => {
    expect(registrableDomain('https://secret123.newsletter.co.uk/feed')).toBe('newsletter.co.uk');
  });
  it('throws on an unparseable URL', () => {
    expect(() => registrableDomain('not a url')).toThrow();
  });
});
```

```js
// lib/premiumRedact.test.js
import { describe, it, expect } from 'vitest';
import { secretParts, redactString, redactContentHtml } from './premiumRedact.js';

const FEED = 'https://example.com/premium/a1b2c3d4e5f6g7h8i9j0/feed.xml?key=s3cr3tk3y99&size=10';

describe('secretParts (spec §4.3 rule 1)', () => {
  it('captures long query values and high-entropy path segments, skips short/common ones', () => {
    const parts = secretParts(FEED);
    expect(parts).toContain('s3cr3tk3y99');          // query value >= 8 chars
    expect(parts).toContain('a1b2c3d4e5f6g7h8i9j0'); // path segment >= 16 chars
    expect(parts).not.toContain('10');               // short query value
    expect(parts).not.toContain('premium');          // short path segment
    expect(parts).not.toContain('feed.xml');         // contains '.', not token-shaped
  });
  it('returns [] for a secret-free URL', () => {
    expect(secretParts('https://example.com/rss/index.xml')).toEqual([]);
  });
});

describe('redactString', () => {
  it('strips every secret part from item links', () => {
    const parts = secretParts(FEED);
    const link = 'https://example.com/article/42?key=s3cr3tk3y99&utm=x';
    const out = redactString(link, parts);
    expect(out).not.toContain('s3cr3tk3y99');
    expect(out).toContain('/article/42');
  });
  it('is a no-op with no parts', () => {
    expect(redactString('https://a.com/b', [])).toBe('https://a.com/b');
  });
});

describe('redactContentHtml', () => {
  it('drops hrefs that carry the token but keeps the anchor text', () => {
    const parts = secretParts(FEED);
    const html = '<p>Body</p><a href="https://example.com/manage?key=s3cr3tk3y99">Manage subscription</a>';
    const out = redactContentHtml(html, parts);
    expect(out).not.toContain('s3cr3tk3y99');
    expect(out).toContain('Manage subscription');
  });
  it('redacts bare token occurrences in text', () => {
    const parts = secretParts(FEED);
    expect(redactContentHtml('token is s3cr3tk3y99 here', parts)).not.toContain('s3cr3tk3y99');
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run lib/hostHint.test.js lib/premiumRedact.test.js` → FAIL (modules not found).

- [ ] **Step 4: Implement**

```js
// lib/hostHint.js
// Masked identity for premium feeds (spec §3.1): registrable domain only —
// some subscriber schemes embed reader tokens in subdomain labels, so the
// full hostname is not safe to show or log.
import { getDomain } from 'tldts';

export function registrableDomain(urlString) {
  const { hostname } = new URL(urlString);
  return getDomain(hostname) || hostname;
}
```

```js
// lib/premiumRedact.js
// Token redaction for premium feed data (spec §4.3 rule 1): subscriber feeds
// re-embed the registered URL's token in item links and body footers; every
// occurrence of a secret component must be stripped server-side before any
// response. Heuristics: query values >= 8 chars; path segments >= 16 chars of
// token-shaped characters (no dots — filenames are not tokens).
const MIN_QUERY_VALUE = 8;
const MIN_PATH_SEGMENT = 16;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;
const REPLACEMENT = 'redacted';

export function secretParts(feedUrl) {
  let url;
  try {
    url = new URL(feedUrl);
  } catch {
    return [];
  }
  const parts = new Set();
  for (const [, value] of url.searchParams) {
    if (value.length >= MIN_QUERY_VALUE) parts.add(value);
  }
  for (const segment of url.pathname.split('/')) {
    if (segment.length >= MIN_PATH_SEGMENT && TOKEN_SHAPE.test(segment)) parts.add(segment);
  }
  return [...parts];
}

export function redactString(text, parts) {
  if (typeof text !== 'string' || parts.length === 0) return text;
  return parts.reduce((acc, part) => acc.split(part).join(REPLACEMENT), text);
}

export function redactContentHtml(html, parts) {
  if (typeof html !== 'string' || parts.length === 0) return html;
  // Neutralize token-bearing hrefs first (keep anchor text), then sweep bare occurrences.
  const withoutHrefs = html.replace(/\shref="([^"]*)"/gi, (match, href) =>
    parts.some((p) => href.includes(p)) ? '' : match
  );
  return redactString(withoutHrefs, parts);
}
```

- [ ] **Step 5: Verify** — `npx vitest run lib/hostHint.test.js lib/premiumRedact.test.js` → PASS. Then `npm test` → all passing, exit 0. Then `npm run build` → exit 0 (tldts must not enter the client bundle — it won't; nothing in `src/` imports it).

- [ ] **Step 6: Commit**

```bash
git add lib/hostHint.js lib/hostHint.test.js lib/premiumRedact.js lib/premiumRedact.test.js package.json package-lock.json
git commit -m "feat(2e): hostHint (registrable domain) + premium token redaction helpers"
```

---

### Task 4: `lib/premiumRepo.js` — service-role CRUD

**Files:**
- Create: `lib/premiumRepo.js`, `lib/premiumRepo.test.js`
- Modify: `lib/securityBoundary.test.js` (allowlist `lib/premiumRepo.js`)

**Interfaces:**
- Produces (all take `deps = {}` with injectable `client` for tests; masked row = `{ id, label, kind, category, hostHint, createdAt }`):
  - `listFeeds(userId)` → masked rows (never `url`)
  - `getOwnedFeedsWithUrls(userId, ids)` → `[{ id, url, label, kind, category, hostHint }]` (internal-only — callers must never serialize `url` into a response)
  - `countFeeds(userId)` → number; `findByUrl(userId, url)` → `{ id } | null`
  - `insertFeed({ userId, url, label, kind, category, hostHint })` → masked row; throws `PremiumCapError` when the DB trigger rejects (`P0001`), rethrows unique-violation (`23505`) as `PremiumDuplicateError`
  - `updateFeedMeta(userId, id, { label, kind, category })` → masked row | null; `deleteFeed(userId, id)` → boolean
- Consumed by: Tasks 6, 7, 8.

- [ ] **Step 1: Write the failing tests** — mock the Supabase client with the same chained-builder mock style used in `lib/articlesWrite.test.js` (read it first and mirror its `from().select()...` mock helpers). Cover: masked list never contains a `url` key; `getOwnedFeedsWithUrls` filters to `user_id` AND `id in ids`; `insertFeed` maps Postgres error code `P0001` → `PremiumCapError` and `23505` → `PremiumDuplicateError`; `updateFeedMeta` scopes on both `user_id` and `id` and strips undefined fields; `deleteFeed` returns false when no row matched.

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/premiumRepo.test.js` → FAIL.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Allowlist in the boundary test** — add `lib/premiumRepo.js` to `lib/securityBoundary.test.js`'s permitted importers.

- [ ] **Step 5: Verify** — `npx vitest run lib/premiumRepo.test.js lib/securityBoundary.test.js` → PASS; `npm test` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/premiumRepo.js lib/premiumRepo.test.js lib/securityBoundary.test.js
git commit -m "feat(2e): premiumRepo — service-role CRUD with typed cap/duplicate errors"
```

---

### Task 5: feedParser `fetchRawItems` export + real premium fixture + `validateFeedUrl`

**Files:**
- Modify: `lib/feedParser.js` (extract/export `fetchRawItems`), `lib/feedParser.test.js`
- Create: `lib/__fixtures__/premium-substack-full.xml` (real capture), `lib/premiumService.js` (validation half), `lib/premiumService.test.js`

**Interfaces:**
- Produces: `fetchRawItems(source, { timeoutMs })` → `Promise<{ items, finalUrl }>` (raw rss-parser items, post-safeFetch; `source` needs only `feedUrl`); `validateFeedUrl(url, deps?)` → `Promise<{ title, finalUrl }>`, throws `PremiumValidationError` on any failure (non-parse, guard rejection, timeout); `PremiumValidationError` class.
- Consumed by: Task 6 (fetch path), Task 7 (add-time validation).

- [ ] **Step 1: Capture the real fixture (landmine 15 — no hand-built XML)** — Run: `curl -s --max-time 20 'https://www.construction-physics.com/feed' -o lib/__fixtures__/premium-substack-full.xml && head -c 400 lib/__fixtures__/premium-substack-full.xml` → expected: RSS 2.0 XML with `<content:encoded>` full bodies (any full-content Substack works; this one is free but structurally identical to a paid private feed). Then **manually append a token-bearing item** is FORBIDDEN — instead, tests that need a token register the fixture under a token-bearing URL (`https://example.com/premium/a1b2c3d4e5f6g7h8i9j0/feed.xml?key=s3cr3tk3y99`) and inject the fixture as the fetched body; the redaction seam is the registered URL, not the fixture content.

- [ ] **Step 2: Refactor `lib/feedParser.js`** — extract the fetch+parse core of `fetchRSS` into an exported function; `fetchRSS` becomes a thin wrapper. Existing behavior unchanged:

```js
// replaces the current fetchRSS in lib/feedParser.js
export async function fetchRawItems(source, { timeoutMs = 6000 } = {}) {
  const { text, finalUrl } = await safeFetch(source.feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    timeoutMs,
    maxBytes: 3 * 1024 * 1024,
  });
  const xml = await text();
  const feed = await parser.parseString(xml);
  return { items: (feed.items || []).slice(0, 15), title: feed.title || '', finalUrl };
}

async function fetchRSS(source) {
  const { items } = await fetchRawItems(source);
  return mapFeedItems(items, source);
}
```

- [ ] **Step 3: Write failing tests for `validateFeedUrl`**

```js
// lib/premiumService.test.js (validation describe-block; Task 6 appends more)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateFeedUrl, PremiumValidationError } from './premiumService.js';

const FIXTURE = readFileSync(new URL('./__fixtures__/premium-substack-full.xml', import.meta.url), 'utf8');
const TOKEN_URL = 'https://example.com/premium/a1b2c3d4e5f6g7h8i9j0/feed.xml?key=s3cr3tk3y99';

describe('validateFeedUrl (spec §4.1)', () => {
  it('returns feed title and final URL for a parseable feed', async () => {
    const fetchRaw = async () => ({ items: [{}], title: 'Construction Physics', finalUrl: TOKEN_URL });
    const result = await validateFeedUrl(TOKEN_URL, { fetchRaw });
    expect(result.title).toBe('Construction Physics');
    expect(result.finalUrl).toBe(TOKEN_URL);
  });
  it('parses the real fixture end-to-end through the parser seam', async () => {
    const { fetchRawItems } = await import('./feedParser.js');
    // inject fixture at the fetch layer: stub safeFetch is overkill here — parse directly
    const Parser = (await import('rss-parser')).default;
    const feed = await new Parser().parseString(FIXTURE);
    expect(feed.items.length).toBeGreaterThan(0);
    expect(feed.items[0]['content:encoded'] || feed.items[0].content).toBeTruthy();
    expect(typeof fetchRawItems).toBe('function');
  });
  it('wraps any failure (guard, network, non-feed) as PremiumValidationError', async () => {
    const fetchRaw = async () => { throw new Error('Address not allowed'); };
    await expect(validateFeedUrl(TOKEN_URL, { fetchRaw })).rejects.toBeInstanceOf(PremiumValidationError);
  });
  it('rejects a feed with zero items as unparseable', async () => {
    const fetchRaw = async () => ({ items: [], title: '', finalUrl: TOKEN_URL });
    await expect(validateFeedUrl(TOKEN_URL, { fetchRaw })).rejects.toBeInstanceOf(PremiumValidationError);
  });
});
```

- [ ] **Step 4: Run to verify failure** — `npx vitest run lib/premiumService.test.js` → FAIL.

- [ ] **Step 5: Implement the validation half of `lib/premiumService.js`**

```js
// lib/premiumService.js (Task 5 scope — Task 6 extends this file)
// Premium orchestration (spec §4). Validation is add-time only; error DETAIL
// never reaches the caller (anti-oracle — the route returns one generic 422).
import { fetchRawItems } from './feedParser.js';

export class PremiumValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PremiumValidationError';
  }
}

export const PREMIUM_TIMEOUT_MS = 3000;

export async function validateFeedUrl(url, { fetchRaw = fetchRawItems } = {}) {
  try {
    const { items, title, finalUrl } = await fetchRaw({ feedUrl: url }, { timeoutMs: 8000 });
    if (!items || items.length === 0) throw new PremiumValidationError('no items');
    return { title: title || '', finalUrl };
  } catch (err) {
    if (err instanceof PremiumValidationError) throw err;
    throw new PremiumValidationError('validation failed');
  }
}
```

- [ ] **Step 6: Verify** — `npx vitest run lib/premiumService.test.js lib/feedParser.test.js` → PASS (feedParser's existing tests confirm the refactor changed nothing); `npm test` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/feedParser.js lib/premiumService.js lib/premiumService.test.js lib/__fixtures__/premium-substack-full.xml
git commit -m "feat(2e): fetchRawItems export + add-time feed validation with real fixture"
```

---

### Task 6: premiumService — resolve, fetch (3s + TTL cache + redaction), body-on-demand

**Files:**
- Modify: `lib/premiumService.js`, `lib/premiumService.test.js`

**Interfaces:**
- Produces:
  - `resolvePremiumSources(userId, premiumIds, deps?)` → `Promise<defs[]>` where def = `{ id, url, label, kind, category, hostHint }` (owned rows only; input capped at `MAX_PREMIUM_IDS = 10` — excess ids silently dropped after slicing)
  - `fetchPremiumHeadlines(defs, deps?)` → `Promise<{ headlines, stats, premiumStatus }>`; headline = standard card fields + `isPremium: true`, `hasBody`, `premiumFeedId`; `url` token-redacted; `premiumStatus` = `[{ id, ok, reason: 'rejected' | 'unavailable' }]`
  - `getPremiumArticleBody(userId, feedId, articleId, deps?)` → `{ title, url, content } | null` (sanitized via `sanitizeExtractedHtml`, redacted, clamped to `MAX_BODY_CHARS = 500_000`)
  - `resetPremiumCacheForTests()`
- Consumes: `premiumRepo.getOwnedFeedsWithUrls`, `fetchRawItems`, `articleId`, `extractThumbnail`, `secretParts`/`redactString`/`redactContentHtml`, `sanitizeExtractedHtml`.
- Cache: module-level Map keyed by feed row id → `{ at, promise }`; single-flight; TTL `PREMIUM_CACHE_TTL_MS = 90_000`. Cache stores RAW parsed items per feed (post-fetch, pre-mapping) so both the headline path and the body path read through it.

- [ ] **Step 1: Write the failing tests** — append to `lib/premiumService.test.js`; all fetches injected via `deps.fetchRaw`, repo via `deps.getOwned`. Cover (use the Task 5 fixture parsed through rss-parser as the raw items source):
  - `resolvePremiumSources` slices ids to 10 before hitting the repo and returns only owned defs.
  - `fetchPremiumHeadlines`: happy path maps items → `isPremium: true`, `premiumFeedId = def.id`, `sourceName = def.label`, `hasBody` true when `content:encoded` present; item `url` contains no secret part of the def's url.
  - Per-feed isolation: one def whose fetchRaw rejects with an HTTP-status-shaped error (`err.status = 403`) → its `premiumStatus` entry `{ ok: false, reason: 'rejected' }`, other feed's headlines intact; a plain network error → `reason: 'unavailable'`.
  - 3s timeout: a fetchRaw that never resolves → feed marked failed, function returns (use `vi.useFakeTimers()` and advance past `PREMIUM_TIMEOUT_MS`).
  - Single-flight TTL: two concurrent `fetchPremiumHeadlines` calls for the same def → `fetchRaw` called once; after `resetPremiumCacheForTests()` it is called again.
  - `getPremiumArticleBody`: returns sanitized+redacted content for a matching `articleId` (compute the expected id with `articleId(item)` from `lib/articleId.js`); returns null for an unknown article or a feed the user doesn't own; content length ≤ `MAX_BODY_CHARS`; a token-bearing unsubscribe link in the fixture-shaped content loses its href.
  - Log scrubbing: spy on `console.log`/`console.error` during a failing fetch → no logged string contains any secret part of the def's url (log line carries `def.id` + `def.hostHint` only).

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/premiumService.test.js` → FAIL on the new describe-blocks.

- [ ] **Step 3: Implement** — append to `lib/premiumService.js`:

```js
import { articleId } from './articleId.js';
import { extractThumbnail } from './feedParser.js';
import { registrableDomain } from './hostHint.js';
import { getOwnedFeedsWithUrls } from './premiumRepo.js';
import { secretParts, redactString, redactContentHtml } from './premiumRedact.js';
import { sanitizeExtractedHtml } from './sanitizeServer.js';

export const MAX_PREMIUM_IDS = 10;
export const PREMIUM_CACHE_TTL_MS = 90_000;
export const MAX_BODY_CHARS = 500_000;

// Single-flight raw-items cache per feed row (spec §4.2): tab switches and
// the body endpoint reuse one publisher hit per TTL window — this is also our
// publisher-politeness throttle for paid feeds.
let cache = new Map();

export function resetPremiumCacheForTests() {
  cache = new Map();
}

export async function resolvePremiumSources(userId, premiumIds, deps = {}) {
  const get = deps.getOwned || getOwnedFeedsWithUrls;
  const ids = (premiumIds || []).filter((x) => typeof x === 'string').slice(0, MAX_PREMIUM_IDS);
  if (ids.length === 0) return [];
  return get(userId, ids);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('premium timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function cachedRawItems(def, deps) {
  const fetchRaw = deps.fetchRaw || fetchRawItems;
  const now = Date.now();
  const slot = cache.get(def.id);
  if (slot && now - slot.at < PREMIUM_CACHE_TTL_MS) return slot.promise;
  const promise = withTimeout(
    fetchRaw({ feedUrl: def.url }, { timeoutMs: PREMIUM_TIMEOUT_MS }),
    PREMIUM_TIMEOUT_MS
  ).then((result) => {
    // Redirect drift (spec §5.3): content from a registrable domain the user
    // never approved is treated as a rejected feed, never silently rendered.
    if (result.finalUrl && registrableDomain(result.finalUrl) !== def.hostHint) {
      const err = new Error('host drift');
      err.status = 403;
      throw err;
    }
    return result;
  }).catch((err) => {
    if (cache.get(def.id)?.promise === promise) cache.delete(def.id);
    throw err;
  });
  cache.set(def.id, { at: now, promise });
  return promise;
}

function itemBody(item) {
  const body = item['content:encoded'] || item.content || '';
  return typeof body === 'string' ? body : '';
}

function mapPremiumItem(item, def, parts) {
  const id = articleId(item);
  if (!id) return null;
  const snippet = typeof item.contentSnippet === 'string' ? item.contentSnippet.trim() : '';
  return {
    id,
    title: redactString(item.title?.trim() || (snippet ? snippet.split('\n')[0].slice(0, 140) : 'Untitled'), parts),
    url: redactString(item.link || '', parts),
    sourceId: def.id,
    premiumFeedId: def.id,
    sourceName: def.label,
    sourceShortName: def.label.slice(0, 3).toUpperCase(),
    sourceColor: '#666666',
    category: def.category,
    thumbnail: redactString(extractThumbnail(item) || '', parts) || null,
    publishedAt: item.pubDate || item.isoDate ? new Date(item.pubDate || item.isoDate).toISOString() : new Date().toISOString(),
    isPaywall: false,
    isPremium: true,
    hasBody: itemBody(item).length > 0,
  };
}

export async function fetchPremiumHeadlines(defs, deps = {}) {
  const headlines = [];
  const premiumStatus = [];
  let succeeded = 0;
  await Promise.all(
    defs.map(async (def) => {
      const parts = secretParts(def.url);
      try {
        const { items } = await cachedRawItems(def, deps);
        for (const item of items) {
          try {
            const mapped = mapPremiumItem(item, def, parts);
            if (mapped) headlines.push(mapped);
          } catch { /* one bad item must not sink the feed */ }
        }
        succeeded++;
        premiumStatus.push({ id: def.id, ok: true });
      } catch (err) {
        // Custody rule 4: id + hostHint only — err.message may embed the URL.
        const rejected = err && [401, 403, 404, 410].includes(err.status);
        console.log(`[premium] ${def.id} (${def.hostHint}): FAILED (${rejected ? 'rejected' : 'unavailable'})`);
        premiumStatus.push({ id: def.id, ok: false, reason: rejected ? 'rejected' : 'unavailable' });
      }
    })
  );
  headlines.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return { headlines, stats: { total: defs.length, succeeded, failed: defs.length - succeeded }, premiumStatus };
}

export async function getPremiumArticleBody(userId, feedId, targetArticleId, deps = {}) {
  const [def] = await resolvePremiumSources(userId, [feedId], deps);
  if (!def) return null;
  const parts = secretParts(def.url);
  let items;
  try {
    ({ items } = await cachedRawItems(def, deps));
  } catch {
    console.log(`[premium] ${def.id} (${def.hostHint}): body fetch FAILED`);
    return null;
  }
  const item = items.find((i) => articleId(i) === targetArticleId);
  if (!item) return null;
  const raw = itemBody(item);
  if (!raw) return null;
  const content = redactContentHtml(sanitizeExtractedHtml(raw), parts).slice(0, MAX_BODY_CHARS);
  return {
    title: redactString(item.title?.trim() || 'Untitled', parts),
    url: redactString(item.link || '', parts),
    content,
  };
}
```

Also update `lib/urlGuard.js`'s `safeFetch` consumers? No — but `fetchRawItems` must surface HTTP status for the rejected/unavailable split: in `lib/feedParser.js`, after `safeFetch` resolves, add:

```js
  if (response.status >= 400) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
```

placed in `fetchRawItems` between `safeFetch` and `text()` (destructure `response` from `safeFetch`'s return). Existing catalog behavior is unchanged: a 4xx feed previously failed at the parse step; it now fails one line earlier with a typed status.

- [ ] **Step 4: Verify** — `npx vitest run lib/premiumService.test.js lib/feedParser.test.js` → PASS; `npm test` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/premiumService.js lib/premiumService.test.js lib/feedParser.js
git commit -m "feat(2e): premium fetch pipeline — TTL single-flight cache, 3s timeout, redaction, body-on-demand"
```

---

### Task 7: `api/premium-feeds.mjs` — the authed management route

**Files:**
- Create: `api/premium-feeds.mjs`, `api/premium-feeds.test.js`
- Modify: `vercel.json` (functions entry)

**Interfaces:**
- Produces the HTTP contract of spec §4.1 (Task 9's client calls these exactly):
  - `GET /api/premium-feeds` → 200 `{ feeds: [maskedRow] }`
  - `GET /api/premium-feeds?feed=<uuid>&article=<id>` → 200 `{ article: { title, url, content } }` | 404 `{ error: 'Not found' }`
  - `POST` `{ url, kind, label?, category? }` → 201 masked row | 400 `{ error: 'https required' }` | 403 `{ error: 'Premium feed limit reached (5)' }` | 409 `{ error: 'Already added' }` | 422 `{ error: 'Could not validate feed URL' }` (generic — ALL other causes)
  - `PATCH` `{ id, label?, kind?, category? }` → 200 masked row | 404
  - `DELETE` `{ id }` → 200 `{ deleted: true }` | 404
  - Any auth failure on any method → 401 `{ error: 'Unauthorized' }`; rate-limited → 429.
- Rate limits: per-IP `premium:${ip}` 30/60s on every method, plus per-user `premium-add:${userId}` 10/600s on POST and `premium-body:${userId}` 60/60s on the body GET.

- [ ] **Step 1: Write the failing route tests** — mirror `api/feeds.test.js`'s handler-test style (read it first; it invokes the default export with mock `req`/`res`). Inject deps via the route's `deps` export pattern below (vitest `vi.mock` of `lib/*` modules is the house alternative — follow whatever `api/feeds.test.js` does). Cover:
  - No/invalid token → 401 on GET/POST/PATCH/DELETE (mock `requireUser` to throw `AuthError`).
  - Verifier throw (non-AuthError shape does not exist — `requireUser` wraps everything; assert route maps `AuthError` → 401 only, everything else → 500 without url leakage).
  - POST happy path → 201, response has `hostHint`, has NO `url` key (assert `JSON.stringify(body)` does not contain the submitted url string).
  - POST `http://` → 400; cap (`PremiumCapError` from insert) → 403; dupe (`findByUrl` hit or `PremiumDuplicateError`) → 409.
  - POST anti-oracle: `validateFeedUrl` throwing for three different injected causes yields byte-identical 422 bodies.
  - POST order: when `countFeeds` returns 5, `validateFeedUrl` is NOT called (cheap-before-network, spec §4.1).
  - Body GET: unknown article → 404 with generic body; owned feed + known article → 200 content.
  - PATCH foreign id (repo returns null) → 404; DELETE foreign id → 404.

- [ ] **Step 2: Run to verify failure** — `npx vitest run api/premium-feeds.test.js` → FAIL.

- [ ] **Step 3: Implement**

```js
// api/premium-feeds.mjs
import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { requireUser, AuthError } from '../lib/authVerify.js';
import { assertPublicUrl } from '../lib/urlGuard.js';
import { registrableDomain } from '../lib/hostHint.js';
import { validateFeedUrl, getPremiumArticleBody } from '../lib/premiumService.js';
import {
  listFeeds, countFeeds, findByUrl, insertFeed, updateFeedMeta, deleteFeed,
  PremiumCapError, PremiumDuplicateError,
} from '../lib/premiumRepo.js';

const MAX_PREMIUM_FEEDS = 5;
const GENERIC_VALIDATION = { error: 'Could not validate feed URL' };
const KINDS = new Set(['news', 'blog']);

function parseBody(req) {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { allowed } = await checkRateLimit(`premium:${clientIp(req)}`, { limit: 30, windowSec: 60 });
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  let userId;
  try {
    ({ userId } = await requireUser(req));
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(500).json({ error: 'Internal error' });
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const feedId = url.searchParams.get('feed');
      const articleId = url.searchParams.get('article');
      if (feedId && articleId) {
        const bodyLimit = await checkRateLimit(`premium-body:${userId}`, { limit: 60, windowSec: 60 });
        if (!bodyLimit.allowed) return res.status(429).json({ error: 'Too many requests' });
        const article = await getPremiumArticleBody(userId, feedId, articleId);
        if (!article) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ article });
      }
      return res.status(200).json({ feeds: await listFeeds(userId) });
    }

    const body = parseBody(req);
    if (body === null) return res.status(400).json({ error: 'Invalid JSON' });

    if (req.method === 'POST') {
      const addLimit = await checkRateLimit(`premium-add:${userId}`, { limit: 10, windowSec: 600 });
      if (!addLimit.allowed) return res.status(429).json({ error: 'Too many requests' });

      const { url, kind, label, category } = body;
      // Cheap checks before ANY network (spec §4.1 order).
      if (typeof url !== 'string' || !/^https:\/\//i.test(url.trim())) {
        return res.status(400).json({ error: 'https required' });
      }
      const cleanUrl = url.trim();
      if (!KINDS.has(kind)) return res.status(400).json({ error: 'kind must be news or blog' });
      if ((await countFeeds(userId)) >= MAX_PREMIUM_FEEDS) {
        return res.status(403).json({ error: `Premium feed limit reached (${MAX_PREMIUM_FEEDS})` });
      }
      if (await findByUrl(userId, cleanUrl)) return res.status(409).json({ error: 'Already added' });

      // Network phase — every failure collapses to one generic 422 (anti-oracle).
      let title, finalUrl;
      try {
        await assertPublicUrl(cleanUrl);
        ({ title, finalUrl } = await validateFeedUrl(cleanUrl));
      } catch {
        return res.status(422).json(GENERIC_VALIDATION);
      }

      try {
        const row = await insertFeed({
          userId,
          url: cleanUrl,
          label: (typeof label === 'string' && label.trim() ? label.trim() : title || registrableDomain(finalUrl)).slice(0, 200),
          kind,
          category: typeof category === 'string' && category.trim() ? category.trim().slice(0, 50) : 'custom',
          hostHint: registrableDomain(finalUrl),
        });
        return res.status(201).json(row);
      } catch (err) {
        if (err instanceof PremiumCapError) return res.status(403).json({ error: `Premium feed limit reached (${MAX_PREMIUM_FEEDS})` });
        if (err instanceof PremiumDuplicateError) return res.status(409).json({ error: 'Already added' });
        throw err;
      }
    }

    if (req.method === 'PATCH') {
      const { id, label, kind, category } = body;
      if (typeof id !== 'string') return res.status(400).json({ error: 'id required' });
      if (kind !== undefined && !KINDS.has(kind)) return res.status(400).json({ error: 'kind must be news or blog' });
      const row = await updateFeedMeta(userId, id, {
        label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : undefined,
        kind,
        category: typeof category === 'string' && category.trim() ? category.trim().slice(0, 50) : undefined,
      });
      if (!row) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(row);
    }

    if (req.method === 'DELETE') {
      const { id } = body;
      if (typeof id !== 'string') return res.status(400).json({ error: 'id required' });
      const deleted = await deleteFeed(userId, id);
      if (!deleted) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Custody rule 4: never echo err.message — it may embed a URL.
    console.error('[premium-feeds] request failed:', err.name || 'Error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
```

- [ ] **Step 4: vercel.json** — in `"functions"`, add `"api/premium-feeds.mjs": { "maxDuration": 30 }`.

- [ ] **Step 5: Verify** — `npx vitest run api/premium-feeds.test.js` → PASS; `npm test` → exit 0; `npm run build` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add api/premium-feeds.mjs api/premium-feeds.test.js vercel.json
git commit -m "feat(2e): authed premium-feeds route — add/list/patch/delete/body with anti-oracle errors"
```

---

### Task 8: `/api/feeds` + feedService — premium merge

**Files:**
- Modify: `api/feeds.mjs`, `api/feeds.test.js`, `lib/feedService.js`, `lib/feedService.test.js`

**Interfaces:**
- `getHeadlinesForSources(requestedSources, { category, premium, deps })` — new optional `premium = { userId, ids }`; when present, premium headlines/stats merge into the existing catalog+custom result and the return gains `premiumStatus`.
- POST `/api/feeds` request: `{ sources, category, premiumIds? }` + optional `Authorization` header. `sources` may be `[]` when `premiumIds` is a non-empty array. Response gains `premiumStatus?` and `premiumAuthFailed?: true`.
- Consumed by: Task 10's client wiring.

- [ ] **Step 1: Write failing feedService tests** — in `lib/feedService.test.js`, with `deps.fetchPremium` injected (add it to `defaultDeps`): premium result merges into `finalize` output sorted by date; premium stats add into `feedStats`; `premiumStatus` passthrough; no `premium` arg → behavior byte-identical to today (regression guard: run existing tests unchanged).

- [ ] **Step 2: Write failing route tests** — in `api/feeds.test.js`: (a) `sources: []` + `premiumIds: ['x']` + valid token → 200 (validation relaxed); (b) `sources: []` + no premiumIds → 400 (existing rule holds); (c) invalid token + premiumIds → 200 with `premiumAuthFailed: true` and no premium headlines; (d) `premiumIds` longer than 10 → sliced, not 400 (assert resolve called with ≤ 10); (e) per-user premium limiter (`premium-fetch:${userId}` 30/60s) exceeded → premium omitted with `premiumStatus: []` and `premiumAuthFailed` absent — catalog still served (never 429 the whole feed for a premium limiter).

- [ ] **Step 3: Run to verify failure** — `npx vitest run lib/feedService.test.js api/feeds.test.js` → FAIL on new cases.

- [ ] **Step 4: Implement feedService merge** — in `lib/feedService.js`: add `fetchPremiumHeadlines`/`resolvePremiumSources` to `defaultDeps` (imported from `./premiumService.js`); extend `getHeadlinesForSources`:

```js
export async function getHeadlinesForSources(requestedSources, { category = null, premium = null, deps = {} } = {}) {
  const d = defaultDeps(deps);
  const catalogIds = [];
  const custom = [];
  for (const s of requestedSources) {
    const canonical = s && typeof s.id === 'string' ? d.catalogIndex.canonicalId(s.id) : null;
    if (canonical) {
      if (!catalogIds.includes(canonical)) catalogIds.push(canonical);
    } else {
      custom.push(s);
    }
  }
  const [catalogResult, customResult, premiumResult] = await Promise.all([
    catalogIds.length > 0
      ? readCatalog(catalogIds, category, d)
      : Promise.resolve({ headlines: [], served: 'none', stats: ZERO_STATS }),
    custom.length > 0
      ? d.fetchFeeds(custom, { category })
      : Promise.resolve({ headlines: [], stats: ZERO_STATS }),
    premium && premium.ids?.length > 0
      ? d.resolvePremiumSources(premium.userId, premium.ids)
          .then((defs) => d.fetchPremiumHeadlines(defs))
      : Promise.resolve({ headlines: [], stats: ZERO_STATS, premiumStatus: [] }),
  ]);
  const merged = finalize(catalogResult, {
    headlines: [...customResult.headlines, ...premiumResult.headlines],
    stats: sumStats(customResult.stats, premiumResult.stats),
  });
  return { ...merged, premiumStatus: premiumResult.premiumStatus };
}
```

(Category filtering for premium happens client-side by surface — premium defs are already kind-selected by the client; do not filter premium by `category` server-side.)

- [ ] **Step 5: Implement the route change** — in `api/feeds.mjs` POST branch:

```js
    const { sources: customSources, category, premiumIds } = body || {};
    const hasPremiumRequest = Array.isArray(premiumIds) && premiumIds.length > 0;
    if (!Array.isArray(customSources) || (customSources.length === 0 && !hasPremiumRequest)) {
      return res.status(400).json({ error: 'sources array is required' });
    }
    if (customSources.length > 30) {
      return res.status(400).json({ error: 'Too many sources (max 30)' });
    }

    let premium = null;
    let premiumAuthFailed = false;
    if (hasPremiumRequest) {
      try {
        const { userId } = await requireUser(req);
        const { allowed: premiumAllowed } = await checkRateLimit(`premium-fetch:${userId}`, { limit: 30, windowSec: 60 });
        if (premiumAllowed) premium = { userId, ids: premiumIds };
      } catch (err) {
        if (err instanceof AuthError) premiumAuthFailed = true;
        else throw err;
      }
    }

    try {
      const { headlines, feedStats, status, premiumStatus } = await getHeadlinesForSources(customSources, { category: category || null, premium });
      if (status !== 200) {
        return res.status(status).json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats });
      }
      const payload = { headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats, premiumStatus: premiumStatus || [] };
      if (premiumAuthFailed) payload.premiumAuthFailed = true;
      return res.status(200).json(payload);
    } catch (err) {
      console.error('Feed fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
    }
```

with `import { requireUser, AuthError } from '../lib/authVerify.js';` added at top.

- [ ] **Step 6: Verify** — `npx vitest run lib/feedService.test.js api/feeds.test.js` → PASS (including all pre-existing cases untouched); `npm test` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add api/feeds.mjs api/feeds.test.js lib/feedService.js lib/feedService.test.js
git commit -m "feat(2e): /api/feeds optional auth — premium merge with per-user limit and auth-failed flag"
```

---

### Task 9: Client — `premiumApi` + `premiumStore`

**Files:**
- Create: `src/lib/premiumApi.js`, `src/lib/premiumApi.test.js`, `src/stores/premiumStore.js`, `src/stores/premiumStore.test.js`

**Interfaces:**
- `premiumApi`: `getAccessToken()` → `string | null` (from `supabase.auth.getSession()`); `listPremiumFeeds()`, `addPremiumFeed({ url, kind, label, category })`, `patchPremiumFeed(id, patch)`, `deletePremiumFeed(id)`, `fetchPremiumBody(feedId, articleId)` — all attach `Authorization: Bearer`, all throw on `!res.ok` with the server's `error` string.
- `premiumStore` (zustand): state `{ feeds: [], enabledIds: [] }` (enabledIds persisted at localStorage key `masthead-premiumEnabled`); actions `loadFeeds()` (GET + reconcile per spec §5.2: drop enabled ids not in the list, auto-enable server ids never seen locally), `addFeed(input)` (POST + append + enable), `patchFeed(id, patch)`, `removeFeed(id)`, `toggleEnabled(id)`, `reset()` (clears state + the localStorage key); selector `getEnabledPremiumIdsByKind(kind)` → `string[]`.
- Consumed by: Tasks 10, 11, 12.

- [ ] **Step 1: Write failing tests** — mock `fetch` (premiumApi) and mock `premiumApi` (premiumStore); jsdom localStorage is available (match `src/stores/settingsStore.test.js` setup). Key premiumStore cases:
  - `loadFeeds` with server `[A(news), B(blog)]` and local enabled `[A, DEAD]` → enabled becomes `[A, B]` (DEAD dropped, B auto-enabled as never-seen) and a `seenIds` record (persisted alongside at `masthead-premiumSeen`) now contains A and B.
  - Second `loadFeeds` after the user disabled B → B stays disabled (auto-enable applies only to never-seen ids — that's what `masthead-premiumSeen` exists for).
  - `getEnabledPremiumIdsByKind('news')` returns only enabled news ids.
  - `reset()` empties state and removes both localStorage keys.
  - `toggleEnabled` persists.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/premiumApi.test.js src/stores/premiumStore.test.js` → FAIL.

- [ ] **Step 3: Implement**

```js
// src/lib/premiumApi.js
import { supabase } from './supabase';

const API = '/api/premium-feeds';

export async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

async function authed(method, path, body) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sign in required');
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

export const listPremiumFeeds = () => authed('GET', API).then((d) => d.feeds || []);
export const addPremiumFeed = (input) => authed('POST', API, input);
export const patchPremiumFeed = (id, patch) => authed('PATCH', API, { id, ...patch });
export const deletePremiumFeed = (id) => authed('DELETE', API, { id });
export const fetchPremiumBody = (feedId, articleId) =>
  authed('GET', `${API}?feed=${encodeURIComponent(feedId)}&article=${encodeURIComponent(articleId)}`)
    .then((d) => d.article);
```

```js
// src/stores/premiumStore.js
import { create } from 'zustand';
import * as premiumApi from '../lib/premiumApi';

const ENABLED_KEY = 'masthead-premiumEnabled';
const SEEN_KEY = 'masthead-premiumSeen';

function loadIds(key) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function persist(key, ids) {
  localStorage.setItem(key, JSON.stringify(ids));
}

const usePremiumStore = create((set, get) => ({
  feeds: [],
  enabledIds: loadIds(ENABLED_KEY),

  // Reconciliation (spec §5.2, landmine-17 pattern): server truth wins for
  // existence; never-seen server ids default to enabled — a feed the user
  // paid to set up must not be invisible on a new device.
  loadFeeds: async () => {
    const feeds = await premiumApi.listPremiumFeeds();
    const serverIds = new Set(feeds.map((f) => f.id));
    const seen = new Set(loadIds(SEEN_KEY));
    const kept = get().enabledIds.filter((id) => serverIds.has(id));
    const autoEnabled = feeds.filter((f) => !seen.has(f.id) && !kept.includes(f.id)).map((f) => f.id);
    const enabledIds = [...kept, ...autoEnabled];
    persist(ENABLED_KEY, enabledIds);
    persist(SEEN_KEY, [...new Set([...seen, ...serverIds])]);
    set({ feeds, enabledIds });
  },

  addFeed: async (input) => {
    const row = await premiumApi.addPremiumFeed(input);
    set((state) => {
      const enabledIds = [...state.enabledIds, row.id];
      persist(ENABLED_KEY, enabledIds);
      persist(SEEN_KEY, [...new Set([...loadIds(SEEN_KEY), row.id])]);
      return { feeds: [...state.feeds, row], enabledIds };
    });
    return row;
  },

  patchFeed: async (id, patch) => {
    const row = await premiumApi.patchPremiumFeed(id, patch);
    set((state) => ({ feeds: state.feeds.map((f) => (f.id === id ? row : f)) }));
    return row;
  },

  removeFeed: async (id) => {
    await premiumApi.deletePremiumFeed(id);
    set((state) => {
      const enabledIds = state.enabledIds.filter((x) => x !== id);
      persist(ENABLED_KEY, enabledIds);
      return { feeds: state.feeds.filter((f) => f.id !== id), enabledIds };
    });
  },

  toggleEnabled: (id) => {
    set((state) => {
      const enabledIds = state.enabledIds.includes(id)
        ? state.enabledIds.filter((x) => x !== id)
        : [...state.enabledIds, id];
      persist(ENABLED_KEY, enabledIds);
      return { enabledIds };
    });
  },

  getEnabledPremiumIdsByKind: (kind) => {
    const { feeds, enabledIds } = get();
    const enabled = new Set(enabledIds);
    return feeds.filter((f) => f.kind === kind && enabled.has(f.id)).map((f) => f.id);
  },

  reset: () => {
    localStorage.removeItem(ENABLED_KEY);
    localStorage.removeItem(SEEN_KEY);
    set({ feeds: [], enabledIds: [] });
  },
}));

export default usePremiumStore;
```

- [ ] **Step 4: Verify** — `npx vitest run src/lib/premiumApi.test.js src/stores/premiumStore.test.js` → PASS; `npm test` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/premiumApi.js src/lib/premiumApi.test.js src/stores/premiumStore.js src/stores/premiumStore.test.js
git commit -m "feat(2e): client premium api + store with reconciliation and per-kind selection"
```

---

### Task 10: Client wiring — feedStore guard + auth retry, api.js, sign-out sweep

**Files:**
- Modify: `src/stores/feedStore.js`, `src/stores/feedStore.test.js`, `src/lib/api.js`, `src/stores/authStore.js`
- Create: `src/stores/authStore.test.js` (if absent — check first; extend if present)

**Interfaces:**
- `selectNewsRequest`/`selectBlogsRequest` now return `{ sources, category, fallbackToCatalog, premiumIds }` (premiumIds from `usePremiumStore.getState().getEnabledPremiumIdsByKind(kind)`; the social branch returns `premiumIds: []`).
- `fetchHeadlinesWithSources(sources, { category, premiumIds, accessToken })` → attaches `premiumIds` to the body and `Authorization` when both present.
- feedStore state gains `premiumIssues: []` (from response `premiumStatus` entries with `ok: false`, joined with labels client-side in the UI task) and `premiumAuthFailed: boolean`.
- `signOut()` additionally: `usePremiumStore.getState().reset()`, resets both feed stores, `caches.delete('api-cache')`.

- [ ] **Step 1: Write failing feedStore tests** — extend `src/stores/feedStore.test.js` (read existing mocks first; it already mocks `../lib/api` and settings state). New cases (LANDMINE 16 — both directions):
  - zero sources + zero premiumIds → NO network call, empty headlines (existing behavior, now with the new condition).
  - zero sources + `premiumIds: ['p1']` → network call happens with `premiumIds: ['p1']` and an access token.
  - non-empty sources + premiumIds → both in the payload.
  - response with `premiumAuthFailed: true` → store calls `supabase.auth.refreshSession()` once and retries once; a second `premiumAuthFailed` sets state `premiumAuthFailed: true` without looping.
  - response `premiumStatus` failures land in `premiumIssues`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/stores/feedStore.test.js` → FAIL.

- [ ] **Step 3: Implement** — `src/lib/api.js`:

```js
export async function fetchHeadlinesWithSources(sources, { category, premiumIds, accessToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken && premiumIds?.length) headers.Authorization = `Bearer ${accessToken}`;
  const body = { sources, category };
  if (premiumIds?.length) body.premiumIds = premiumIds;
  const res = await fetch(`${API_BASE}/feeds`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Failed to fetch headlines: ${res.status}`);
  return res.json();
}
```

`src/stores/feedStore.js` — the changed core of `fetchFeeds` (selectors and imports at top: `import usePremiumStore from './premiumStore'; import { getAccessToken } from '../lib/premiumApi'; import { supabase } from '../lib/supabase';`):

```js
    fetchFeeds: async () => {
      const requestId = ++requestSeq;
      const { selectedCategory } = get();
      set({ isLoading: true, error: null });
      const applyIfLatest = (partial) => {
        if (requestId === requestSeq) set(partial);
      };
      try {
        const settings = useSettingsStore.getState();
        const { sources, category, fallbackToCatalog, premiumIds = [] } = selectRequest(settings, selectedCategory);

        if (sources.length === 0 && premiumIds.length === 0 && !fallbackToCatalog) {
          // Kind-scoped surface with nothing enabled — an empty slice, not the
          // server's default catalog (landmine 16, amended for premium 2E §5.2).
          applyIfLatest({ headlines: [], fetchedAt: new Date().toISOString(), isLoading: false });
          return;
        }

        const sourcesPayload = sources.map((s) => ({
          id: s.id || s.source_id,
          name: s.name,
          shortName: s.shortName || s.short_name,
          url: s.url,
          feedUrl: s.feedUrl || s.feed_url,
          feedType: s.feedType || s.feed_type || 'rss',
          category: s.category,
          color: s.color,
          paywall: s.paywall || false,
        }));

        const accessToken = premiumIds.length > 0 ? await getAccessToken() : null;
        let data = await fetchHeadlinesWithSources(sourcesPayload, { category, premiumIds, accessToken });

        if (data.premiumAuthFailed && supabase) {
          // Spec §4.2: refresh the session and retry exactly once — never silent.
          await supabase.auth.refreshSession();
          const retryToken = await getAccessToken();
          data = await fetchHeadlinesWithSources(sourcesPayload, { category, premiumIds, accessToken: retryToken });
        }

        applyIfLatest({
          headlines: data.headlines || [],
          fetchedAt: data.fetchedAt,
          isLoading: false,
          premiumAuthFailed: !!data.premiumAuthFailed,
          premiumIssues: (data.premiumStatus || []).filter((s) => !s.ok),
        });
      } catch {
        applyIfLatest({ error: 'Could not refresh feeds', isLoading: false });
      }
    },
```

with initial state gaining `premiumIssues: [], premiumAuthFailed: false`, and the selectors:

```js
export const selectNewsRequest = (settings, selectedCategory) => {
  const premium = usePremiumStore.getState();
  return selectedCategory === 'social'
    ? { sources: settings.getEffectiveSourcesByKind('social'), category: null, fallbackToCatalog: false, premiumIds: [] }
    : { sources: settings.getEffectiveSourcesByKind('news'), category: selectedCategory, fallbackToCatalog: false, premiumIds: premium.getEnabledPremiumIdsByKind('news') };
};

export const selectBlogsRequest = (settings, selectedCategory) => ({
  sources: settings.getEffectiveSourcesByKind('blog'),
  category: selectedCategory,
  fallbackToCatalog: false,
  premiumIds: usePremiumStore.getState().getEnabledPremiumIdsByKind('blog'),
});
```

- [ ] **Step 4: Sign-out sweep** — in `src/stores/authStore.js` `signOut()`'s `finally` block, after `initFromStorage()`:

```js
      const usePremiumStore = (await import('./premiumStore')).default;
      usePremiumStore.getState().reset();
      const { useNewsFeedStore, useBlogsFeedStore } = await import('./feedStore');
      for (const store of [useNewsFeedStore, useBlogsFeedStore]) {
        store.setState({ headlines: [], fetchedAt: null, error: null, premiumIssues: [], premiumAuthFailed: false });
      }
      // The Workbox runtime cache would otherwise hand the masked premium list
      // to the next account on a shared device (2E §5.2 / red-team finding).
      if (typeof caches !== 'undefined') {
        await caches.delete('api-cache').catch(() => {});
      }
```

Write/extend the authStore test: mock supabase + dynamic imports; assert after `signOut()` both feed stores are empty, premiumStore was reset, and `caches.delete` was called with `'api-cache'`.

- [ ] **Step 5: Verify** — `npx vitest run src/stores/feedStore.test.js src/stores/authStore.test.js` → PASS; `npm test` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/stores/feedStore.js src/stores/feedStore.test.js src/lib/api.js src/stores/authStore.js src/stores/authStore.test.js
git commit -m "feat(2e): premium request wiring, landmine-16 guard amendment, auth retry, sign-out sweep"
```

---

### Task 11: UI — AddSourceModal premium path + Settings premium rows

**Files:**
- Modify: `src/components/AddSourceModal.jsx`, create `src/components/AddSourceModal.test.jsx` (or extend if present)
- Create: `src/components/PremiumSourceRow.jsx`, `src/components/PremiumSourceRow.test.jsx`
- Modify: `src/pages/SettingsPage.jsx`

**Interfaces:**
- Consumes: `usePremiumStore` (addFeed, patchFeed, removeFeed, toggleEnabled, feeds, enabledIds), `useAuthStore` (user), `suggestKind`.
- AddSourceModal keeps its existing `onAdd`/`onClose` props; premium submissions bypass `onAdd` entirely (they go through the store).

- [ ] **Step 1: Write failing AddSourceModal tests** — @testing-library/react (match existing component-test style in the repo; check `src/components/` for an existing `.test.jsx` to mirror). Cases:
  - Premium checkbox unchecked → existing discovery flow untouched (find button visible).
  - Checked while signed out → sign-in prompt rendered, no submit button action.
  - Checked while signed in → input `autoComplete` is `"off"` and its `name` differs between two mounts (randomized); explainer text contains "like a password".
  - Submitting calls `premiumStore.addFeed` with `{ url, kind, label: undefined, category }` and on success renders the masked confirmation (`label · hostHint`) and clears the input; the typed URL string is not present in the DOM after success.
  - Kind radio hides nothing (news/blog only exist already); social never appears.

- [ ] **Step 2: Implement the modal changes** — add state `const [isPremium, setIsPremium] = useState(false);` `const [premiumAdded, setPremiumAdded] = useState(null);` `const [premiumError, setPremiumError] = useState(null);` and a stable-per-mount random name `const premiumFieldName = useRef('url-' + Math.random().toString(36).slice(2)).current;`. Below the kind radiogroup insert:

```jsx
          {/* Premium subscriber feed (2E §5.1) */}
          <label className="flex items-start gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={isPremium}
              onChange={(e) => setIsPremium(e.target.checked)}
              className="mt-0.5"
            />
            <span className="font-ui text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Premium subscriber feed</span>
              {' — '}URL contains your personal token: stored securely, never shown again.
              Treat this link like a password — anyone who has it can read your paid content.
            </span>
          </label>
```

When `isPremium && !user` render the sign-in prompt instead of the URL form. When `isPremium && user`, the URL input switches to the hardened variant (`autoComplete="off"`, `name={premiumFieldName}`, `id={premiumFieldName}`, placeholder "Paste your subscriber feed URL (https://…)") and the Find button becomes "Add" calling:

```jsx
  const handleAddPremium = async () => {
    setPremiumError(null);
    try {
      const row = await usePremiumStore.getState().addFeed({
        url: url.trim(),
        kind,
        category,
      });
      setPremiumAdded(row);
      setUrl('');
    } catch (err) {
      setPremiumError(err.message);
    }
  };
```

with a success block rendering `{premiumAdded.label} · {premiumAdded.hostHint}` with a lock icon and a Done button (→ `onClose`). `suggestKind(url)` pre-picks kind on input blur in premium mode too.

- [ ] **Step 3: Write failing PremiumSourceRow tests** — masked display (`label · hostHint`, never a full URL), lock badge present, toggle calls `toggleEnabled(id)`, delete confirms then calls `removeFeed(id)`, expanding edit shows label input + kind radio + category select and Save calls `patchFeed(id, { label, kind, category })`.

- [ ] **Step 4: Implement `PremiumSourceRow.jsx`**

```jsx
// src/components/PremiumSourceRow.jsx
import { useState } from 'react';
import usePremiumStore from '../stores/premiumStore';
import Icon from './ui/Icon';

const CATEGORIES = ['bangladesh', 'macro', 'tech', 'custom'];

export default function PremiumSourceRow({ feed }) {
  const { enabledIds, toggleEnabled, removeFeed, patchFeed } = usePremiumStore();
  const [isEditing, setIsEditing] = useState(false);
  const [label, setLabel] = useState(feed.label);
  const [kind, setKind] = useState(feed.kind);
  const [category, setCategory] = useState(feed.category);
  const isEnabled = enabledIds.includes(feed.id);

  const handleSave = async () => {
    await patchFeed(feed.id, { label, kind, category });
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (window.confirm(`Remove ${feed.label}? You'll need the URL from your subscription page to re-add it.`)) {
      await removeFeed(feed.id);
    }
  };

  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-3">
        <Icon name="lock" size={14} aria-label="Premium feed" style={{ color: 'var(--accent)' }} />
        <div className="flex-1 min-w-0">
          <p className="font-ui text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {feed.label}
          </p>
          <p className="font-mono text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
            {feed.hostHint}
          </p>
        </div>
        <button onClick={() => setIsEditing((v) => !v)} className="p-1" aria-label={`Edit ${feed.label}`} style={{ color: 'var(--text-tertiary)' }}>
          <Icon name="edit" size={16} />
        </button>
        <button onClick={handleDelete} className="p-1" aria-label={`Remove ${feed.label}`} style={{ color: 'var(--text-tertiary)' }}>
          <Icon name="close" size={16} />
        </button>
        <button
          role="switch"
          aria-checked={isEnabled}
          aria-label={`Toggle ${feed.label}`}
          onClick={() => toggleEnabled(feed.id)}
          className="w-10 h-6 rounded-full relative shrink-0"
          style={{ backgroundColor: isEnabled ? 'var(--accent)' : 'var(--border)' }}
        >
          <span
            className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
            style={{ transform: isEnabled ? 'translateX(18px)' : 'translateX(2px)' }}
          />
        </button>
      </div>
      {isEditing && (
        <div className="mt-3 space-y-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Feed label"
            className="w-full px-3 py-2 rounded-lg font-ui text-sm"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          />
          <div className="flex gap-2" role="radiogroup" aria-label="Appears in">
            {[['news', 'News'], ['blog', 'Blogs']].map(([value, text]) => (
              <button
                key={value}
                role="radio"
                aria-checked={kind === value}
                onClick={() => setKind(value)}
                className="flex-1 px-3 py-1.5 rounded-lg font-ui text-xs font-medium"
                style={{
                  backgroundColor: kind === value ? 'var(--accent)' : 'var(--bg-surface)',
                  color: kind === value ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                {text}
              </button>
            ))}
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Category"
            className="w-full px-3 py-2 rounded-lg font-ui text-sm"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            onClick={handleSave}
            className="w-full px-3 py-2 rounded-lg font-ui text-sm font-medium"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
```

(If `Icon` lacks `lock`/`edit` glyphs, add them to `src/components/ui/Icon.jsx` following its existing svg-map pattern.)

- [ ] **Step 5: Wire into SettingsPage** — import `usePremiumStore` + `PremiumSourceRow`; call `loadFeeds()` in an effect when `user` is present; inside the existing `sourceGroups.map`, after the group's `SourceToggleRow`s, render this kind's premium feeds:

```jsx
            {user && premiumFeedsByKind[groupKind]?.map((feed) => (
              <PremiumSourceRow key={feed.id} feed={feed} />
            ))}
```

where `premiumFeedsByKind` groups `usePremiumStore((s) => s.feeds)` by `kind` and `groupKind` is derived from the group tuple (read how `sourceGroups` is built earlier in the file and key by the same kind value; blogs group gets `blog` premium feeds, news group gets `news`).

- [ ] **Step 6: Verify** — `npx vitest run src/components/AddSourceModal.test.jsx src/components/PremiumSourceRow.test.jsx` → PASS; `npm test` → exit 0; `npx eslint src/components/AddSourceModal.jsx src/components/PremiumSourceRow.jsx src/pages/SettingsPage.jsx` → zero new issues.

- [ ] **Step 7: Commit**

```bash
git add src/components/AddSourceModal.jsx src/components/AddSourceModal.test.jsx src/components/PremiumSourceRow.jsx src/components/PremiumSourceRow.test.jsx src/pages/SettingsPage.jsx src/components/ui/Icon.jsx
git commit -m "feat(2e): premium add flow with autofill hardening + Settings premium rows"
```

---

### Task 12: Reader body-on-demand, premium failure banner, save path

**Files:**
- Modify: `src/stores/articleStore.js`, `src/components/HeadlineCard.jsx`, `src/pages/ReaderPage.jsx`, `src/pages/FeedLayout.jsx`, `src/lib/library.js`, `src/lib/library.test.js`
- Create/extend: `src/stores/articleStore.test.js`

**Interfaces:**
- `articleStore.fetchPremiumArticle(feedId, articleId)` → sets `article = { id: articleId, title, url, content, isPremium: true }` via `premiumApi.fetchPremiumBody`; error path sets the store's existing `error`.
- HeadlineCard nav state gains `isPremium`, `hasBody`, `premiumFeedId` (pass-through from the headline object — read the component's `navigate(...)` call and extend its `state` object with the three fields).
- `library.saveArticle`: when `savedVia === 'premium'`, the body attach uses `fetchPremiumBody(sourceMeta.sourceId, finalId)` instead of the extractor.
- FeedLayout renders a dismissible banner when the active feed store's `premiumIssues` is non-empty.

- [ ] **Step 1: Write failing articleStore tests** — mock `../lib/premiumApi`: `fetchPremiumArticle` success sets `article.content` and `isLoading: false`; rejection sets `error` and never calls `extractArticle`.

- [ ] **Step 2: Implement articleStore**

```js
  fetchPremiumArticle: async (feedId, articleId) => {
    set({ isLoading: true, error: null, article: null });
    try {
      const { fetchPremiumBody } = await import('../lib/premiumApi');
      const body = await fetchPremiumBody(feedId, articleId);
      set({ article: { id: articleId, ...body, isPremium: true }, isLoading: false });
    } catch (err) {
      set({ error: err.message, isLoading: false });
    }
  },
```

- [ ] **Step 3: ReaderPage branch** — extend the destructuring of `location.state` with `isPremium, hasBody, premiumFeedId`, and in the main effect put the premium check FIRST:

```js
    if (isPremium && hasBody && premiumFeedId && id) {
      // Premium: body comes from the feed via the authed endpoint — the
      // extractor would hit the paywall and return a teaser (2E §5.3).
      fetchPremiumArticle(premiumFeedId, id);
    } else if (fromFavorites && id) {
      // ... existing branches unchanged
```

(`fetchPremiumArticle` destructured from `useArticleStore()` alongside the existing actions. `isPremium && !hasBody` intentionally falls through to the existing `fetchArticle(url, sourceId)` extractor path.)

- [ ] **Step 4: HeadlineCard pass-through** — read `src/components/HeadlineCard.jsx`; find the reader `navigate` call and add to its state object: `isPremium: headline.isPremium, hasBody: headline.hasBody, premiumFeedId: headline.premiumFeedId` (using whatever local variable names the component binds the item to). If the card renders an external-link anchor for `linkOut` sources, premium items must NOT take that branch (`isPremium` items always navigate in-app).

- [ ] **Step 5: FeedLayout banner** — subscribe `premiumIssues` from the layout's feed store instance; above the card list render:

```jsx
      {premiumIssues.length > 0 && !issuesDismissed && (
        <div
          role="status"
          className="mx-4 my-2 px-3 py-2 rounded-lg flex items-start gap-2 font-ui text-xs"
          style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          <span className="flex-1">
            {premiumIssues.some((i) => i.reason === 'rejected')
              ? 'A premium feed was rejected by its publisher — its token may have expired. Re-add the URL from your subscription page (Settings).'
              : 'A premium feed is temporarily unavailable — its articles will return on a later refresh.'}
          </span>
          <button onClick={() => setIssuesDismissed(true)} aria-label="Dismiss" style={{ color: 'var(--text-tertiary)' }}>✕</button>
        </div>
      )}
```

with `const [issuesDismissed, setIssuesDismissed] = useState(false);` reset when `premiumIssues` changes identity.

- [ ] **Step 6: library save branch + tests** — in `src/lib/library.js`, locate the body-attach path that runs after `saveFavorite` for `pendingBody: true` records (the same seam 2C uses for extractor-backed bodies — follow `savedVia` through the file). Add the premium branch:

```js
  if (savedVia === 'premium' && sourceMeta.sourceId) {
    const { fetchPremiumBody } = await import('./premiumApi');
    const body = await fetchPremiumBody(sourceMeta.sourceId, finalId);
    if (body?.content) {
      await patchSavedArticle(finalId, { content: body.content, pendingBody: false, bodyFailed: false });
    } else {
      await patchSavedArticle(finalId, { pendingBody: false, bodyFailed: true });
    }
    return finalId;
  }
```

adapted to the file's actual attach helper names (read before editing; `patchSavedArticle` exists in `src/lib/db.js` per `sync.js` imports). Test: mock `premiumApi`; `saveArticle` with `savedVia: 'premium'` never calls the extractor and stores the premium content.

- [ ] **Step 7: Wire the save call sites** — where the reader/card heart invokes `saveArticle` (find `savedVia` values at call sites), pass `savedVia: 'premium'` and `sourceMeta.sourceId = premiumFeedId` when the item `isPremium`.

- [ ] **Step 8: Verify** — `npx vitest run src/stores/articleStore.test.js src/lib/library.test.js` → PASS; `npm test` → exit 0; `npx eslint` on touched files → zero new.

- [ ] **Step 9: Commit**

```bash
git add src/stores/articleStore.js src/stores/articleStore.test.js src/pages/ReaderPage.jsx src/components/HeadlineCard.jsx src/pages/FeedLayout.jsx src/lib/library.js src/lib/library.test.js
git commit -m "feat(2e): premium reader body-on-demand, failure banner, premium save path"
```

---

### Task 13: Ship — migration apply, probes, AGENTS amendment, gates, live drive

**Files:**
- Modify: `AGENTS.md` (landmine 16 text + gates table if present)
- No other code changes — this is the rollout gate (spec §9).

- [ ] **Step 1: AGENTS.md landmine 16 amendment** — append to landmine 16's text: "2E amendment: the guard condition is `sources.length === 0 && premiumIds.length === 0 && !fallbackToCatalog` — a premium-only surface MUST still fetch. Both directions are pinned by `src/stores/feedStore.test.js`."

- [ ] **Step 2: Full local gates** — Run each WITHOUT piping through tail/head/grep, record exit codes:
  - `npm test` → exit 0; report final count vs 194 baseline.
  - `npm run build` → exit 0 (bundle guard included).
  - `npx eslint .` → baseline 4 errors + 5 warnings, zero new.

- [ ] **Step 3: Apply the migration** — owner-gated: apply `20260719_create_user_premium_feeds.sql` to project `helavgnmsednyivsprrp` via the established route (supabase CLI `db push` or dashboard SQL editor — match how 2C's migrations were applied; check `supabase/` config). STOP and get explicit owner approval before touching the production database.

- [ ] **Step 4: Custody probes** — Run: `npm run probe-premium` → all PASS lines, exit 0. For the concurrent-cap block, run once with `SUPABASE_SERVICE_ROLE_KEY` and a `PROBE_USER_ID` (owner's own test account id) exported. Record output verbatim in the PR.

- [ ] **Step 5: PR + checks** — push `feat/2e-premium-feeds`, open the PR with the spec/plan links and probe output, `gh pr checks --watch`. House /ship flow; merge is owner-gated.

- [ ] **Step 6: Post-deploy live drive (spec §7)** — on masthead-news.vercel.app with a signed-in test account: add `https://www.construction-physics.com/feed` as a premium blog feed (stand-in token-bearer); verify masked Settings row + lock badge; Blogs tab shows its cards; reader renders body via `GET /api/premium-feeds?feed=…` (confirm in devtools — no `/api/extract` call); heart an article and confirm the saved copy; PATCH the label; delete the feed and confirm reconciliation removes it from the enabled set; sign out and confirm Settings shows no premium rows and Cache Storage has no `api-cache` entry with a `premium-feeds` request. Screenshots per house practice.
- [ ] **Step 7: Prod leak sweep (spec §9.4)** — with a real tokenized URL registered (owner supplies one, or construct a query-token variant): `curl` the list and feeds responses for the drive account and assert the token substring absent (`grep -c` on the token → 0). Record commands + output.

---

## Plan Self-Review Log

- **Spec coverage:** §3.1/§3.2 → Task 1; §4.1 → Tasks 2, 5, 7; §4.2 → Tasks 6, 8; §4.3 rules 1–6 → Tasks 3, 6, 7 (leak tests), 13 (prod sweep, request-body-capture is a standing constraint with no tooling to configure today); §5.1 → Task 11; §5.2 → Tasks 9, 10, 11; §5.3 → Task 12; §5.4 → Task 12; §6 edge cases → distributed (rejected/unavailable Task 6, redirect-drift host comparison folded into `hostHint` + `premiumStatus` handling, cap/dupe Task 7, signed-out Task 10, excerpt-only fallback Task 12); §7 test map → each task's test steps + Task 13; §9 → Task 13.
- **Deferred plan decisions resolved:** JWT mechanism = admin-client `auth.getUser` (Task 2); redaction heuristics = query ≥ 8 / path ≥ 16 token-shaped (Task 3); TTL = 90s; premium rate limits = 30/60s IP, 10/600s add, 60/60s body, 30/60s fetch per user; eTLD+1 = `tldts`; body clamp = 500k chars.
- **Known judgment calls for implementers:** SettingsPage group-kind derivation depends on how `sourceGroups` is keyed (read the file first). Redirect drift is fully specified in Task 6's `cachedRawItems` (registrable-domain mismatch → `status: 403` → `reason: 'rejected'`), plus a Task 6 test: a `fetchRaw` resolving with a drifted `finalUrl` yields `premiumStatus` `{ ok: false, reason: 'rejected' }`.
- **Type consistency check:** masked row shape (`hostHint` camelCase in JSON, `host_hint` in SQL) consistent across Tasks 4/7/9/11; `premiumFeedId = sourceId = row uuid` consistent across Tasks 6/12; `premiumStatus` reasons `'rejected' | 'unavailable'` consistent across Tasks 6/8/12.
