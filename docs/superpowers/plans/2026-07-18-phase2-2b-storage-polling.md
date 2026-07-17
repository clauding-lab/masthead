# Phase 2 · Slice 2B — Server-side Article Storage + Polling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fetch-on-demand with store-and-serve: a Vercel Cron poller writes headline metadata into a new Supabase `articles` table every 20 minutes; `/api/feeds` serves catalog sources from that store (custom sources stay live), with zero client change.

**Architecture:** All shared server logic lives in `lib/` and is imported by both `api/*.mjs` (prod) and `server.js` (dev) — AGENTS landmine #1. The read path (`supabaseRead` → `articlesRepo` → `feedService`) and the write path (`supabaseAdmin` → `articlesWrite` → `pollRunner`) are separate import graphs; the service-role factory never enters the read path. Identity is single-sourced in pure-JS `lib/articleId.js` used by server AND browser (IndexedDB re-key).

**Tech Stack:** React 19 + Vite PWA, Vercel serverless (`api/*.mjs`) + Hono dev server (`server.js`), Supabase (`@supabase/supabase-js` ^2.100.1, already installed), vitest 4, idb 8, fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-07-11-phase2-2b-storage-polling-design.md` (hardened, owner-approved 2026-07-18). Decisions D1–D6 are locked there.

## Global Constraints

- **No new npm dependency.** `@supabase/supabase-js` is already installed.
- **Client contract unchanged:** `POST /api/feeds` request/response shape stays `{ headlines, fetchedAt, cached, feedStats }`; `src/lib/api.js` + `src/stores/feedStore.js` are NOT edited.
- **Guard chain preserved verbatim** in `api/feeds.mjs`: `applyCors` → OPTIONS 204 → `checkRateLimit` (`feeds:<ip>`, 60/60s → 429) → JSON parse guard → non-empty `sources` array → 30-source cap.
- **No `VITE_`-prefixed name is ever read by server code.** Server reads `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `CRON_SECRET` only.
- **No CSP / security-header change** in `vercel.json` — only `regions`, `crons`, `functions` keys change.
- **Retention:** prune `first_seen_at < now() − 14 days`; no per-source cap. `first_seen_at` is never overwritten on upsert.
- **Gates run bare** — never pipe `npm test` / `npm run build` / eslint through `tail`/`head`/`grep`. Lint baseline: `npx eslint src lib api server.js` exits 1 with exactly 3 pre-existing `set-state-in-effect` errors; new code adds zero.
- **Public-repo hygiene:** commit/PR prose describes guards added, never an open-hole timeline.
- **Conventional commits.** Branch `phase2-2b`; never push main; merge only via approved PR.
- **Prod actions (migration apply, Vercel env vars, deploy) happen ONLY in Task 13 after one enumerated pre-flight approval.**

---

### Task 1: Shared pure-JS article identity — `lib/articleId.js`

**Files:**
- Create: `lib/articleId.js`
- Test: `lib/articleId.test.js`

**Interfaces:**
- Produces: `canonicalizeUrl(raw: string) → string|null` (null on empty/unparseable/non-http(s) input — never throws); `articleId(input: string | {link?, guid?, title?}) → string|null` (16-hex 64-bit id; null only when no link/guid/title key exists). Used by Tasks 2, 6, 7, 10.

- [ ] **Step 1: Write the failing test** — `lib/articleId.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, articleId } from './articleId.js';

describe('canonicalizeUrl', () => {
  it('returns null on empty, junk, and non-http(s) input instead of throwing', () => {
    expect(canonicalizeUrl('')).toBeNull();
    expect(canonicalizeUrl(null)).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl('tag:blogger.com,1999:blog-123.post-456')).toBeNull();
  });
  it('is stable across scheme, www, trailing slash, and param order', () => {
    const a = canonicalizeUrl('http://www.example.com/story/?b=2&a=1');
    expect(a).toBe(canonicalizeUrl('https://example.com/story?a=1&b=2'));
  });
  it('strips tracking params but keeps meaningful ones', () => {
    expect(canonicalizeUrl('https://x.com/p?utm_source=t&fbclid=z&id=7'))
      .toBe(canonicalizeUrl('https://x.com/p?id=7'));
    expect(canonicalizeUrl('https://x.com/p?id=7'))
      .not.toBe(canonicalizeUrl('https://x.com/p?id=8'));
  });
});

describe('articleId', () => {
  it('is total: never throws, null only when no key exists', () => {
    expect(articleId({})).toBeNull();
    expect(articleId(null)).toBeNull();
    expect(articleId({ guid: '' , title: '' })).toBeNull();
    expect(typeof articleId({ guid: 'tag:site,2026:1' })).toBe('string');
    expect(typeof articleId({ title: 'Only a title' })).toBe('string');
  });
  it('gives two different link-less items two different ids', () => {
    expect(articleId({ guid: 'g-1' })).not.toBe(articleId({ guid: 'g-2' }));
  });
  it('returns a 16-hex id, identical for url-variant inputs, and accepts a bare string', () => {
    const id = articleId({ link: 'https://www.example.com/a/' });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).toBe(articleId('http://example.com/a'));
  });
  it('prefers link over guid over title', () => {
    const linked = articleId({ link: 'https://x.com/a', guid: 'g', title: 't' });
    expect(linked).toBe(articleId({ link: 'https://x.com/a' }));
    expect(articleId({ guid: 'g', title: 't' })).toBe(articleId({ guid: 'g' }));
  });
});
```

- [ ] **Step 2: Run** `npx vitest run lib/articleId.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `lib/articleId.js`:

```js
// Single source of truth for article identity (2B spec §5.3, decision D4).
// Pure JS — no node:crypto — so server (feedParser, extractor, poller) and
// browser (IndexedDB re-key) compute byte-identical ids.

const TRACKING_PARAM =
  /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|_hsenc|_hsmi|s_kwcid|yclid|cmpid|ito)$/;

export function canonicalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.protocol = 'https:';
  url.hash = '';
  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  url.hostname = host;
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k.toLowerCase()));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

// cyrb64 — 64-bit non-crypto hash. This is a dedup key, not a security token.
function hash64hex(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// Total: never throws. Null only when the item has no usable key — callers
// drop those items. Fallback order link → guid → title keeps link-less
// items distinct (spec Finding 4).
export function articleId(input) {
  if (input == null) return null;
  const item = typeof input === 'string' ? { link: input } : input;
  const link = typeof item.link === 'string' ? item.link : null;
  const guid = typeof item.guid === 'string' && item.guid.trim() !== '' ? item.guid.trim() : null;
  const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : null;
  const key = canonicalizeUrl(link) ?? guid ?? title;
  if (key == null) return null;
  return hash64hex(key);
}
```

- [ ] **Step 4: Run** `npx vitest run lib/articleId.test.js` — Expected: PASS (all tests).
- [ ] **Step 5: Commit** — `git add lib/articleId.js lib/articleId.test.js && git commit -m "feat: shared pure-JS article identity (canonicalize + 64-bit hash)"`

---

### Task 2: Single-source identity in `feedParser` + `extractor`

**Files:**
- Modify: `lib/feedParser.js` (lines 1–9: imports + `hashUrl`; line 53: id assignment)
- Modify: `lib/extractor.js` (lines 1–9: imports + `hashUrl`; line 115: id assignment)
- Test: `lib/feedParser.test.js` (extend)

**Interfaces:**
- Consumes: `articleId` from Task 1.
- Produces: `mapFeedItems` now emits 16-hex ids and DROPS items with no link/guid/title (previously they got a random id). `fetchAllFeeds`/`fetchFeed`/`extractThumbnail` signatures unchanged. Reader id (`extractArticle().id`) computed from the same function, so list-id == reader-id.

- [ ] **Step 1: Extend the test** — append to `lib/feedParser.test.js` inside `describe('mapFeedItems')`:

```js
  it('emits the shared 16-hex articleId and keeps guid-only items stable', () => {
    const item = { title: 'ok', link: 'https://x.example/a', pubDate: '2026-01-01' };
    const [mapped] = mapFeedItems([item], SOURCE);
    expect(mapped.id).toMatch(/^[0-9a-f]{16}$/);
    const guidOnly = { title: 'no link', guid: 'tag:site,2026:99' };
    const [g1] = mapFeedItems([guidOnly], SOURCE);
    const [g2] = mapFeedItems([guidOnly], SOURCE);
    expect(g1.id).toBe(g2.id);
  });
  it('drops an item with no link, guid, or title instead of inventing an id', () => {
    expect(mapFeedItems([{ pubDate: '2026-01-01' }], SOURCE)).toHaveLength(0);
  });
```

- [ ] **Step 2: Run** `npx vitest run lib/feedParser.test.js` — Expected: FAIL (id is 12-hex md5; empty item currently gets a random id).
- [ ] **Step 3: Implement.** In `lib/feedParser.js`: delete `import crypto from 'crypto';` and the `hashUrl` function; add `import { articleId } from './articleId.js';`. Replace the loop body of `mapFeedItems`:

```js
  for (const item of items) {
    try {
      const id = articleId(item);
      if (!id) continue; // no link, guid, or title — nothing to key on
      mapped.push({
        id,
        title: item.title?.trim() || 'Untitled',
        url: item.link || '',
        sourceId: source.id,
        sourceName: source.name,
        sourceShortName: source.shortName,
        sourceColor: source.color,
        category: source.category,
        thumbnail: extractThumbnail(item),
        publishedAt: parseDate(item.pubDate || item.isoDate),
        isPaywall: source.paywall || false,
      });
    } catch {
      // One malformed item must not sink the feed.
    }
  }
```

In `lib/extractor.js`: delete `import crypto from 'crypto';` and `hashUrl`; add `import { articleId } from './articleId.js';`; change `id: hashUrl(url),` to `id: articleId(url),`.

- [ ] **Step 4: Run** `npx vitest run lib` — Expected: PASS (including the pre-existing poisoned-item test — `articleId(item)` is called inside the try block).
- [ ] **Step 5: Commit** — `git add lib/feedParser.js lib/feedParser.test.js lib/extractor.js && git commit -m "refactor: single-source article identity via lib/articleId"`

---

### Task 3: `articles` table migration (RLS + explicit grants)

**Files:**
- Create: `supabase/migrations/20260718_create_articles.sql`

**Interfaces:**
- Produces: `public.articles` with PK `(source_id, id)`, columns consumed by Tasks 5–7. NOT applied to prod in this task — file only; apply happens in Task 13 after pre-flight approval.

- [ ] **Step 1: Write the migration** (mirrors spec §6 verbatim — `enable RLS` + revoke incl. PUBLIC + explicit grants; a policy alone does NOT enable RLS: AGENTS landmine #5 / postgres-revoke-public-gotcha):

```sql
-- Phase 2 Slice 2B: server-side headline store (spec §4, §6).
-- Write path: service_role only (the cron poller). Read path: public SELECT.
create table public.articles (
  source_id text not null,
  id text not null,
  url text not null,
  title text,
  source_name text,
  source_short_name text,
  source_color text,
  category text,
  thumbnail text,
  is_paywall boolean not null default false,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, id)
);

create index articles_published_at_idx on public.articles (published_at desc);
create index articles_source_published_idx on public.articles (source_id, published_at desc);
create index articles_category_published_idx on public.articles (category, published_at desc);
create index articles_first_seen_idx on public.articles (first_seen_at);

-- Creating a policy does NOT enable RLS; this statement is load-bearing.
alter table public.articles enable row level security;

-- Explicit privilege baseline, correct under BOTH Supabase default-privilege
-- regimes (older auto-grant-all and newer no-default-grant). Revoking from
-- PUBLIC as well: role grants can be inherited through PUBLIC membership.
revoke all on table public.articles from public, anon, authenticated;
grant select on table public.articles to anon, authenticated;
grant select, insert, update, delete on table public.articles to service_role;

create policy "articles public read"
  on public.articles for select to anon, authenticated using (true);
-- Deliberately NO insert/update/delete policy for anon/authenticated.
```

- [ ] **Step 2: Sanity-check the SQL is well-formed** — Run: `node -e "const s=require('fs').readFileSync('supabase/migrations/20260718_create_articles.sql','utf8'); if(!/enable row level security/.test(s)||!/revoke all/.test(s)) process.exit(1); console.log('ok')"` — Expected: `ok`.
- [ ] **Step 3: Commit** — `git add supabase/migrations/20260718_create_articles.sql && git commit -m "feat: articles table migration — composite PK, RLS enabled, explicit grants"`

---

### Task 4: Server Supabase clients — read (anon) + admin (service-role, tripwired)

**Files:**
- Create: `lib/supabaseRead.js`
- Create: `lib/supabaseAdmin.js`
- Test: `lib/securityBoundary.test.js`

**Interfaces:**
- Produces: `getReadClient() → SupabaseClient|null` (null when `SUPABASE_URL`/`SUPABASE_ANON_KEY` unset — callers treat store as unavailable and fall back live); `resetReadClientForTests()`; `getAdminClient() → SupabaseClient` (THROWS when env unset — write path fails loud). Consumed by Tasks 5–7.

- [ ] **Step 1: Write the failing boundary test** — `lib/securityBoundary.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (/\.(js|jsx|mjs)$/.test(entry)) files.push(p);
  }
  return files;
}

// Spec §6: a documented landmine is a live hole until a failing test enforces it.
describe('service-role import boundary', () => {
  it('no src/** file imports supabaseAdmin or articlesWrite, or names the service-role key', () => {
    for (const f of walk('src')) {
      const content = readFileSync(f, 'utf8');
      expect(content, f).not.toMatch(/supabaseAdmin|articlesWrite|SERVICE_ROLE/);
    }
  });
  it('supabaseAdmin has a browser tripwire and never reads a VITE_ name', () => {
    const content = readFileSync('lib/supabaseAdmin.js', 'utf8');
    expect(content).toMatch(/typeof window !== 'undefined'/);
    expect(content).not.toMatch(/VITE_/);
  });
  it('the read-path modules never reference the admin factory', () => {
    for (const f of ['lib/supabaseRead.js', 'lib/articlesRepo.js', 'lib/feedService.js']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/supabaseAdmin|SERVICE_ROLE/);
    }
  });
});
```

(The third assertion fails until Tasks 5 and 8 create those files — implement Tasks 4–8 before expecting the whole file green; within this task run only the first two tests via `-t` filters if needed.)

- [ ] **Step 2: Implement** `lib/supabaseRead.js`:

```js
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
```

- [ ] **Step 3: Implement** `lib/supabaseAdmin.js`:

```js
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
```

- [ ] **Step 4: Run** `npx vitest run lib/securityBoundary.test.js -t "src"` and `-t "tripwire"` — Expected: both PASS (third test still red until Task 8; that's expected mid-stream).
- [ ] **Step 5: Commit** — `git add lib/supabaseRead.js lib/supabaseAdmin.js lib/securityBoundary.test.js && git commit -m "feat: server-side supabase clients with service-role import tripwire"`

---

### Task 5: Read repo — `lib/articlesRepo.js`

**Files:**
- Create: `lib/articlesRepo.js`
- Test: `lib/articlesRepo.test.js`

**Interfaces:**
- Consumes: `getReadClient` (Task 4).
- Produces: `selectHeadlines({ sourceIds: string[], category?: string|null, limit?: number }, client?) → Promise<Headline[]>` (camelCase shape identical to `mapFeedItems` output minus nothing — keys asserted equal); `storeIsWarm(client?) → Promise<boolean>`; `rowToHeadline(row) → Headline`; `StoreUnavailableError`. Consumed by Task 8.

- [ ] **Step 1: Write the failing test** — `lib/articlesRepo.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { selectHeadlines, storeIsWarm, rowToHeadline, StoreUnavailableError } from './articlesRepo.js';
import { mapFeedItems } from './feedParser.js';

const ROW = {
  id: 'a'.repeat(16), url: 'https://x.com/a', title: 'T', source_id: 'daily-star',
  source_name: 'The Daily Star', source_short_name: 'DS', source_color: '#E31E24',
  category: 'bangladesh', thumbnail: null, is_paywall: false,
  published_at: '2026-07-18T00:00:00.000Z',
};

function fakeClient(result = { data: [ROW], error: null }) {
  const calls = { in: null, eq: null, order: null, limit: null };
  const builder = {
    select: vi.fn(() => builder),
    in: vi.fn((col, vals) => { calls.in = [col, vals]; return builder; }),
    eq: vi.fn((col, val) => { calls.eq = [col, val]; return builder; }),
    order: vi.fn((col, opts) => { calls.order = [col, opts]; return builder; }),
    limit: vi.fn((n) => { calls.limit = n; return Promise.resolve(result); }),
    then: (resolve) => resolve(result),
  };
  return { client: { from: vi.fn(() => builder) }, calls, builder };
}

describe('selectHeadlines', () => {
  it('maps rows to the exact mapFeedItems headline shape (snake→camel)', async () => {
    const { client } = fakeClient();
    const [headline] = await selectHeadlines({ sourceIds: ['daily-star'] }, client);
    const src = { id: 's', name: 'n', shortName: 'sn', color: '#fff', category: 'c', paywall: false };
    const [reference] = mapFeedItems([{ title: 't', link: 'https://x.com/r', pubDate: '2026-01-01' }], src);
    expect(Object.keys(headline).sort()).toEqual(Object.keys(reference).sort());
  });
  it('passes category as a bound .eq value — PostgREST filter syntax injects nothing', async () => {
    const { client, calls } = fakeClient();
    const hostile = 'x,or(id.eq.1)';
    await selectHeadlines({ sourceIds: ['daily-star'], category: hostile }, client);
    expect(calls.eq).toEqual(['category', hostile]); // passed as a value, never string-built
  });
  it('filters non-string source ids and clamps limit to 200', async () => {
    const { client, calls } = fakeClient();
    await selectHeadlines({ sourceIds: ['ok', 42, null], limit: 9999 }, client);
    expect(calls.in).toEqual(['source_id', ['ok']]);
    expect(calls.limit).toBe(200);
  });
  it('returns [] for an empty selection without querying', async () => {
    const { client } = fakeClient();
    expect(await selectHeadlines({ sourceIds: [] }, client)).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });
  it('throws StoreUnavailableError when the client is missing or errors', async () => {
    await expect(selectHeadlines({ sourceIds: ['a'] }, null)).rejects.toBeInstanceOf(StoreUnavailableError);
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(selectHeadlines({ sourceIds: ['a'] }, client)).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});

describe('storeIsWarm', () => {
  it('true when a row exists, false when empty, false without a client, false on error', async () => {
    const warm = { client: { from: () => ({ select: () => ({ limit: () => Promise.resolve({ data: [{ id: 'x' }], error: null }) }) }) } };
    const cold = { client: { from: () => ({ select: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) } };
    const broken = { client: { from: () => ({ select: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'x' } }) }) }) } };
    expect(await storeIsWarm(warm.client)).toBe(true);
    expect(await storeIsWarm(cold.client)).toBe(false);
    expect(await storeIsWarm(null)).toBe(false);
    expect(await storeIsWarm(broken.client)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run lib/articlesRepo.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `lib/articlesRepo.js`:

```js
import { getReadClient } from './supabaseRead.js';

const MAX_LIMIT = 200;
const COLUMNS =
  'id,url,title,source_id,source_name,source_short_name,source_color,category,thumbnail,is_paywall,published_at';

export class StoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

export function rowToHeadline(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceShortName: row.source_short_name,
    sourceColor: row.source_color,
    category: row.category,
    thumbnail: row.thumbnail,
    publishedAt: row.published_at,
    isPaywall: row.is_paywall,
  };
}

// Bound query-builder methods only — never string-built .or()/.filter()
// (spec §5.2 step 2: injection + unbounded-query posture).
export async function selectHeadlines(
  { sourceIds, category = null, limit = MAX_LIMIT } = {},
  client = getReadClient()
) {
  if (!client) throw new StoreUnavailableError('store read client not configured');
  const ids = (Array.isArray(sourceIds) ? sourceIds : []).filter((s) => typeof s === 'string');
  if (ids.length === 0) return [];
  const clamped = Math.min(Math.max(1, Number(limit) || MAX_LIMIT), MAX_LIMIT);
  let query = client
    .from('articles')
    .select(COLUMNS)
    .in('source_id', ids)
    .order('published_at', { ascending: false });
  if (category) query = query.eq('category', category);
  const { data, error } = await query.limit(clamped);
  if (error) throw new StoreUnavailableError(error.message);
  return (data || []).map(rowToHeadline);
}

// Global warmth probe: any row at all? (cold-vs-empty, spec §5.2 step 5)
export async function storeIsWarm(client = getReadClient()) {
  if (!client) return false;
  try {
    const { data, error } = await client.from('articles').select('id').limit(1);
    if (error) return false;
    return (data || []).length > 0;
  } catch {
    return false;
  }
}
```

Note on the fake in Step 1: `selectHeadlines` awaits `query.limit(clamped)`, and when `category` is set the chain is `.in().order().eq().limit()` — the fake returns `builder` from every method and resolves at `.limit()`, so both orders work. Implementation calls `.eq` AFTER `.order` when category is present; the fake records calls regardless of order.

- [ ] **Step 4: Run** `npx vitest run lib/articlesRepo.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add lib/articlesRepo.js lib/articlesRepo.test.js && git commit -m "feat: articles read repo — bound queries, shape parity, warmth probe"`

---

### Task 6: Write path — `lib/articlesWrite.js` (batch dedupe + prune)

**Files:**
- Create: `lib/articlesWrite.js`
- Test: `lib/articlesWrite.test.js`

**Interfaces:**
- Consumes: `getAdminClient` (Task 4); headline shape from Task 2.
- Produces: `headlineToRow(headline) → row` (omits `first_seen_at` so upsert never resets it); `dedupeRows(rows) → rows` (last-write-wins by `(source_id,id)`); `upsertArticles(headlines, client?) → Promise<number>` (rows written; THROWS on DB error); `prune({ maxAgeDays }, client?) → Promise<number>` (rows deleted; throws on error). Consumed by Task 7.

- [ ] **Step 1: Write the failing test** — `lib/articlesWrite.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { headlineToRow, dedupeRows, upsertArticles, prune } from './articlesWrite.js';

const H = (over = {}) => ({
  id: 'f'.repeat(16), url: 'https://x.com/a', title: 'T', sourceId: 'daily-star',
  sourceName: 'The Daily Star', sourceShortName: 'DS', sourceColor: '#E31E24',
  category: 'bangladesh', thumbnail: null, publishedAt: '2026-07-18T00:00:00.000Z',
  isPaywall: false, ...over,
});

function fakeAdmin(result = { error: null, count: 3 }) {
  const calls = {};
  const client = {
    from: vi.fn(() => ({
      upsert: vi.fn((rows, opts) => { calls.upsert = { rows, opts }; return Promise.resolve(result); }),
      delete: vi.fn((opts) => { calls.deleteOpts = opts; return {
        lt: vi.fn((col, val) => { calls.lt = [col, val]; return Promise.resolve(result); }),
      }; }),
    })),
  };
  return { client, calls };
}

describe('headlineToRow', () => {
  it('maps camelCase to snake_case and OMITS first_seen_at (never reset on upsert)', () => {
    const row = headlineToRow(H());
    expect(row.source_id).toBe('daily-star');
    expect(row.is_paywall).toBe(false);
    expect(row.published_at).toBe('2026-07-18T00:00:00.000Z');
    expect('first_seen_at' in row).toBe(false);
    expect(typeof row.updated_at).toBe('string');
  });
});

describe('upsertArticles — the CRITICAL batch-dedupe', () => {
  it('two headlines sharing (source_id,id) in ONE batch upsert as one row, no throw', async () => {
    const { client, calls } = fakeAdmin();
    const n = await upsertArticles([H(), H({ title: 'later wins' })], client);
    expect(n).toBe(1);
    expect(calls.upsert.rows).toHaveLength(1);
    expect(calls.upsert.rows[0].title).toBe('later wins');
    expect(calls.upsert.opts).toEqual({ onConflict: 'source_id,id' });
  });
  it('cross-source same id → two rows preserved', async () => {
    const { client, calls } = fakeAdmin();
    const n = await upsertArticles([H(), H({ sourceId: 'hacker-news' })], client);
    expect(n).toBe(2);
    expect(calls.upsert.rows).toHaveLength(2);
  });
  it('skips id-less or url-less headlines and returns 0 for an empty batch without calling the DB', async () => {
    const { client } = fakeAdmin();
    expect(await upsertArticles([H({ id: null }), H({ url: '' })], client)).toBe(0);
    expect(client.from).not.toHaveBeenCalled();
  });
  it('throws loudly on a DB error', async () => {
    const { client } = fakeAdmin({ error: { message: 'nope' } });
    await expect(upsertArticles([H()], client)).rejects.toThrow(/upsert failed/);
  });
});

describe('prune', () => {
  it('deletes rows older than maxAgeDays by first_seen_at and returns the count', async () => {
    const { client, calls } = fakeAdmin({ error: null, count: 7 });
    const n = await prune({ maxAgeDays: 14 }, client);
    expect(n).toBe(7);
    expect(calls.deleteOpts).toEqual({ count: 'exact' });
    expect(calls.lt[0]).toBe('first_seen_at');
    const cutoff = new Date(calls.lt[1]).getTime();
    const expected = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run lib/articlesWrite.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `lib/articlesWrite.js`:

```js
import { getAdminClient } from './supabaseAdmin.js';

// WRITE side of public.articles — poller only. The read path must never
// import this module (enforced by lib/securityBoundary.test.js).

export function headlineToRow(h) {
  return {
    source_id: h.sourceId,
    id: h.id,
    url: h.url,
    title: h.title,
    source_name: h.sourceName,
    source_short_name: h.sourceShortName,
    source_color: h.sourceColor,
    category: h.category,
    thumbnail: h.thumbnail,
    is_paywall: h.isPaywall || false,
    published_at: h.publishedAt,
    // first_seen_at deliberately omitted: DB default on insert, untouched on
    // conflict-update, so 14-day retention counts from genuine first sight.
    updated_at: new Date().toISOString(),
  };
}

// In-memory dedupe by (source_id, id), last write wins — a single upsert
// statement must never carry a duplicate PK (spec §5.1 step 3, CRITICAL-1).
export function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(`${row.source_id} ${row.id}`, row);
  return [...byKey.values()];
}

export async function upsertArticles(headlines, client = getAdminClient()) {
  const rows = dedupeRows(
    (headlines || [])
      .filter((h) => h && h.id && h.sourceId && h.url)
      .map(headlineToRow)
  );
  if (rows.length === 0) return 0;
  const { error } = await client.from('articles').upsert(rows, { onConflict: 'source_id,id' });
  if (error) throw new Error(`articles upsert failed: ${error.message}`);
  return rows.length;
}

export async function prune({ maxAgeDays = 14 } = {}, client = getAdminClient()) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await client.from('articles').delete({ count: 'exact' }).lt('first_seen_at', cutoff);
  if (error) throw new Error(`articles prune failed: ${error.message}`);
  return count ?? 0;
}
```

- [ ] **Step 4: Run** `npx vitest run lib/articlesWrite.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add lib/articlesWrite.js lib/articlesWrite.test.js && git commit -m "feat: articles write path — in-batch dedupe, retention prune, fail-loud"`

---

### Task 7: Cron poller — `lib/cronAuth.js`, `lib/pollRunner.js`, `api/cron/poll.mjs`

**Files:**
- Create: `lib/cronAuth.js`, `lib/pollRunner.js`, `api/cron/poll.mjs`
- Test: `lib/cronAuth.test.js`, `lib/pollRunner.test.js`, `api/cron/poll.test.js`
- Modify: `vitest.config.js` (add `'api/**/*.test.js'` to `include`)

**Interfaces:**
- Consumes: `fetchAllFeeds` (Task 2 shape), `upsertArticles`/`prune` (Task 6).
- Produces: `verifyCronAuth(req) → boolean` (fail-closed: false when `CRON_SECRET` unset, wrong length, or mismatch; timing-safe compare; never logs the header); `runPoll(deps?) → Promise<{ ok, status, stats, upserted?, pruned?, error? }>`; default export handler in `api/cron/poll.mjs`. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically on Production.

- [ ] **Step 1: Write the failing tests.**

`lib/cronAuth.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyCronAuth } from './cronAuth.js';

const REQ = (auth) => ({ headers: auth === undefined ? {} : { authorization: auth } });

describe('verifyCronAuth (fail-closed, spec §5.1 step 1)', () => {
  const saved = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 's3cret-value-123'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('rejects when CRON_SECRET is unset — closes the "Bearer undefined" bypass', () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronAuth(REQ('Bearer undefined'))).toBe(false);
  });
  it('rejects a missing, malformed, wrong-length, or wrong same-length header', () => {
    expect(verifyCronAuth(REQ(undefined))).toBe(false);
    expect(verifyCronAuth(REQ('s3cret-value-123'))).toBe(false);
    expect(verifyCronAuth(REQ('Bearer nope'))).toBe(false);
    expect(verifyCronAuth(REQ('Bearer s3cret-value-124'))).toBe(false);
  });
  it('accepts the exact bearer token', () => {
    expect(verifyCronAuth(REQ('Bearer s3cret-value-123'))).toBe(true);
  });
});
```

`lib/pollRunner.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { runPoll } from './pollRunner.js';

const HEADLINES = [
  { id: 'a'.repeat(16), sourceId: 'daily-star', url: 'https://x.com/a', title: 'A' },
];

describe('runPoll', () => {
  it('happy path: fetch → upsert → prune, returns 200 with counts', async () => {
    const upsert = vi.fn().mockResolvedValue(1);
    const pruneStore = vi.fn().mockResolvedValue(2);
    const result = await runPoll({
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: HEADLINES, stats: { total: 10, succeeded: 9, failed: 1 } }),
      upsert, pruneStore,
    });
    expect(result).toMatchObject({ ok: true, status: 200, upserted: 1, pruned: 2 });
    expect(upsert).toHaveBeenCalledWith(HEADLINES);
    expect(pruneStore).toHaveBeenCalledWith({ maxAgeDays: 14 });
  });
  it('fails loud with 503 when every feed failed', async () => {
    const upsert = vi.fn();
    const result = await runPoll({
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: [], stats: { total: 10, succeeded: 0, failed: 10 } }),
      upsert, pruneStore: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('lets an upsert failure propagate (handler maps it to 503)', async () => {
    await expect(runPoll({
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: HEADLINES, stats: { total: 10, succeeded: 9, failed: 1 } }),
      upsert: vi.fn().mockRejectedValue(new Error('db down')),
      pruneStore: vi.fn(),
    })).rejects.toThrow('db down');
  });
});
```

`api/cron/poll.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/pollRunner.js', () => ({ runPoll: vi.fn() }));
import { runPoll } from '../../lib/pollRunner.js';
import handler from './poll.mjs';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
  };
}

describe('api/cron/poll handler', () => {
  const saved = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 'tok'; vi.mocked(runPoll).mockReset(); });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('405 on disallowed method', async () => {
    const res = fakeRes();
    await handler({ method: 'DELETE', headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });
  it('401 without valid auth; runPoll never runs', async () => {
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);
    expect(runPoll).not.toHaveBeenCalled();
  });
  it('200 with the run result on success', async () => {
    vi.mocked(runPoll).mockResolvedValue({ ok: true, status: 200, upserted: 5, pruned: 0, stats: { total: 10, succeeded: 10, failed: 0 } });
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.upserted).toBe(5);
  });
  it('503 when the run throws (fail LOUD in the cron dashboard)', async () => {
    vi.mocked(runPoll).mockRejectedValue(new Error('boom'));
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Update `vitest.config.js`** so `api/**` tests run:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.js', 'src/**/*.test.{js,jsx}', 'api/**/*.test.js'],
  },
});
```

Run `npx vitest run lib/cronAuth.test.js lib/pollRunner.test.js api/cron/poll.test.js` — Expected: FAIL (modules not found).

- [ ] **Step 3: Implement.**

`lib/cronAuth.js`:

```js
import { timingSafeEqual } from 'node:crypto';

// Fail-closed cron auth (spec §5.1 step 1): unset secret rejects BEFORE any
// compare (closes "Bearer undefined"); length-guarded timingSafeEqual; the
// Authorization header and the secret are never logged.
export function verifyCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
```

`lib/pollRunner.js`:

```js
import { createRequire } from 'module';
import { fetchAllFeeds } from './feedParser.js';
import { upsertArticles, prune } from './articlesWrite.js';

const require = createRequire(import.meta.url);
const catalog = require('./sources.json');

const RETENTION_DAYS = 14;

// One poll run: fetch all catalog feeds → upsert → prune (spec §5.1).
// Per-feed failures are isolated inside fetchAllFeeds; only zero-success or a
// write failure fails the run.
export async function runPoll(deps = {}) {
  const {
    fetchFeeds = fetchAllFeeds,
    upsert = upsertArticles,
    pruneStore = prune,
    sources = catalog.sources,
  } = deps;

  const { headlines, stats } = await fetchFeeds(sources);
  if (stats.total > 0 && stats.succeeded === 0) {
    return { ok: false, status: 503, stats, error: 'all feeds failed' };
  }
  const upserted = await upsert(headlines);
  const pruned = await pruneStore({ maxAgeDays: RETENTION_DAYS });
  return { ok: true, status: 200, stats, upserted, pruned };
}
```

`api/cron/poll.mjs`:

```js
import { verifyCronAuth } from '../../lib/cronAuth.js';
import { runPoll } from '../../lib/pollRunner.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyCronAuth(req)) {
    // Never log the Authorization header or the secret.
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runPoll();
    return res.status(result.status).json(result);
  } catch (err) {
    console.error('[cron/poll] failed:', err.message);
    return res.status(503).json({ ok: false, error: 'poll failed' });
  }
}
```

- [ ] **Step 4: Run** `npx vitest run lib/cronAuth.test.js lib/pollRunner.test.js api/cron/poll.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add lib/cronAuth.js lib/cronAuth.test.js lib/pollRunner.js lib/pollRunner.test.js api/cron/poll.mjs api/cron/poll.test.js vitest.config.js && git commit -m "feat: cron poller — fail-closed auth, fail-loud run, 14-day prune"`

---

### Task 8: Store-aware feed service — `lib/feedService.js`

**Files:**
- Create: `lib/feedService.js`
- Test: `lib/feedService.test.js`

**Interfaces:**
- Consumes: `selectHeadlines`, `storeIsWarm` (Task 5); `fetchAllFeeds` (Task 2).
- Produces: `getHeadlinesForSources(requestedSources, { category?, deps? }) → Promise<{ headlines, feedStats, status }>` (POST branch); `getCatalogHeadlines({ category?, source?, deps? }) → Promise<{ headlines, feedStats, status }>` (GET branch); `resetFallbackForTests()`. `feedStats` = `{ total, succeeded, failed, served }` where `served ∈ 'store'|'fallback'|'error'|'none'`, live counts only. `status` 200 unless nothing could be served and something failed. Consumed by Task 9.

- [ ] **Step 1: Write the failing test** — `lib/feedService.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getHeadlinesForSources, getCatalogHeadlines, resetFallbackForTests } from './feedService.js';

const STORE_H = { id: 'a'.repeat(16), title: 'S', url: 'https://x.com/s', sourceId: 'daily-star', sourceName: 'DS', sourceShortName: 'DS', sourceColor: '#E31E24', category: 'bangladesh', thumbnail: null, publishedAt: '2026-07-18T05:00:00.000Z', isPaywall: false };
const LIVE_H = { ...STORE_H, id: 'b'.repeat(16), title: 'L', sourceId: 'custom-1', publishedAt: '2026-07-18T06:00:00.000Z' };
const CATALOG_SRC = { id: 'daily-star', feedUrl: 'https://evil.example/hijack.xml' };
const CUSTOM_SRC = { id: 'custom-1', name: 'C', feedUrl: 'https://c.example/rss' };

const deps = () => ({
  storeIsWarm: vi.fn().mockResolvedValue(true),
  selectHeadlines: vi.fn().mockResolvedValue([STORE_H]),
  fetchFeeds: vi.fn().mockResolvedValue({ headlines: [LIVE_H], stats: { total: 1, succeeded: 1, failed: 0 } }),
});

beforeEach(() => resetFallbackForTests());

describe('getHeadlinesForSources (POST branch)', () => {
  it('serves catalog from the store keyed by server-side id — client feedUrl ignored', async () => {
    const d = deps();
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([STORE_H]);
    expect(d.selectHeadlines).toHaveBeenCalledWith({ sourceIds: ['daily-star'], category: null, limit: 200 });
    expect(d.fetchFeeds).not.toHaveBeenCalled(); // the hijack feedUrl never reaches a fetch
    expect(r.feedStats.served).toBe('store');
  });
  it('merges store catalog + live custom, sorted by publishedAt desc', async () => {
    const d = deps();
    const r = await getHeadlinesForSources([CATALOG_SRC, CUSTOM_SRC], { deps: d });
    expect(r.headlines.map((h) => h.title)).toEqual(['L', 'S']);
    expect(d.fetchFeeds).toHaveBeenCalledTimes(1);
    expect(d.fetchFeeds.mock.calls[0][0]).toEqual([CUSTOM_SRC]);
  });
  it('warm store + empty filtered slice returns empty WITHOUT live fallback (cold ≠ empty)', async () => {
    const d = { ...deps(), selectHeadlines: vi.fn().mockResolvedValue([]) };
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([]);
    expect(d.fetchFeeds).not.toHaveBeenCalled();
  });
  it('globally-cold store falls back live for the SELECTED catalog sources only, single-flight cached', async () => {
    const d = { ...deps(), storeIsWarm: vi.fn().mockResolvedValue(false) };
    const r1 = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    const r2 = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r1.feedStats.served).toBe('fallback');
    expect(r1.headlines).toEqual([LIVE_H]);
    expect(r2.headlines).toEqual([LIVE_H]);
    expect(d.fetchFeeds).toHaveBeenCalledTimes(1); // second call hit the cached slot
    const [selected] = d.fetchFeeds.mock.calls[0];
    expect(selected.map((s) => s.id)).toEqual(['daily-star']);
    expect(selected[0].feedUrl).toBe('https://www.thedailystar.net/rss.xml'); // server catalog, not client value
  });
  it('store read error also falls back live', async () => {
    const d = { ...deps(), storeIsWarm: vi.fn().mockRejectedValue(new Error('db down')) };
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.feedStats.served).toBe('fallback');
    expect(r.headlines).toEqual([LIVE_H]);
  });
  it('503 only when nothing was served and live fetching failed', async () => {
    const d = {
      storeIsWarm: vi.fn().mockResolvedValue(false),
      selectHeadlines: vi.fn(),
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: [], stats: { total: 1, succeeded: 0, failed: 1 } }),
    };
    const r = await getHeadlinesForSources([CATALOG_SRC], { deps: d });
    expect(r.status).toBe(503);
  });
  it('SSRF: a custom source pointing at link-local metadata is rejected by the real safeFetch chain', async () => {
    const ssrf = { id: 'evil', name: 'E', feedUrl: 'http://169.254.169.254/latest/meta-data/' };
    const r = await getHeadlinesForSources([ssrf], {}); // real deps; private IP rejects pre-network
    expect(r.status).toBe(503);
    expect(r.feedStats).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
  }, 15000);
});

describe('getCatalogHeadlines (GET branch)', () => {
  it('serves the category-filtered catalog from the store', async () => {
    const d = deps();
    const r = await getCatalogHeadlines({ category: 'bangladesh', deps: d });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([STORE_H]);
    const arg = d.selectHeadlines.mock.calls[0][0];
    expect(arg.category).toBe('bangladesh');
    expect(arg.sourceIds).toEqual(['daily-star', 'business-standard-bd', 'bbc-bangla']);
  });
  it('unknown source filter returns empty 200', async () => {
    const r = await getCatalogHeadlines({ source: 'not-a-source', deps: deps() });
    expect(r.status).toBe(200);
    expect(r.headlines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run lib/feedService.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `lib/feedService.js`:

```js
import { createRequire } from 'module';
import { fetchAllFeeds } from './feedParser.js';
import { selectHeadlines, storeIsWarm } from './articlesRepo.js';

const require = createRequire(import.meta.url);
const catalog = require('./sources.json');
const catalogById = new Map(catalog.sources.map((s) => [s.id, s]));

const MAX_STORE_LIMIT = 200;
const FALLBACK_TTL_MS = 2 * 60 * 1000;
const ZERO_STATS = { total: 0, succeeded: 0, failed: 0 };

// Single-flight cached live fallback (spec §5.2 step 5): one fan-out per warm
// instance per TTL during a cold window or store outage — no thundering herd.
let fallbackSlot = { key: null, at: 0, promise: null };

export function resetFallbackForTests() {
  fallbackSlot = { key: null, at: 0, promise: null };
}

function defaultDeps(deps) {
  return { fetchFeeds: fetchAllFeeds, selectHeadlines, storeIsWarm, ...deps };
}

function liveFallback(sourceIds, category, d) {
  const key = `${[...sourceIds].sort().join(',')}|${category || 'all'}`;
  const now = Date.now();
  if (fallbackSlot.key === key && fallbackSlot.promise && now - fallbackSlot.at < FALLBACK_TTL_MS) {
    return fallbackSlot.promise;
  }
  // Server-side catalog definitions only — never the client's feedUrl.
  const selected = catalog.sources.filter((s) => sourceIds.includes(s.id));
  const promise = d
    .fetchFeeds(selected, { category })
    .then(({ headlines, stats }) => ({ headlines, served: 'fallback', stats }))
    .catch((err) => {
      console.error('[feeds] live fallback failed:', err.message);
      if (fallbackSlot.promise === promise) resetFallbackForTests();
      return { headlines: [], served: 'error', stats: { total: sourceIds.length, succeeded: 0, failed: sourceIds.length } };
    });
  fallbackSlot = { key, at: now, promise };
  return promise;
}

async function readCatalog(sourceIds, category, d) {
  try {
    if (await d.storeIsWarm()) {
      const headlines = await d.selectHeadlines({ sourceIds, category, limit: MAX_STORE_LIMIT });
      // Warm + empty is a genuinely empty slice, NOT cold — no fallback.
      return { headlines, served: 'store', stats: ZERO_STATS };
    }
  } catch (err) {
    console.error('[feeds] store read failed, falling back live:', err.message);
  }
  return liveFallback(sourceIds, category, d);
}

function sumStats(a, b) {
  return {
    total: a.total + b.total,
    succeeded: a.succeeded + b.succeeded,
    failed: a.failed + b.failed,
  };
}

function finalize(catalogResult, customResult) {
  const headlines = [...catalogResult.headlines, ...customResult.headlines].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );
  const live = sumStats(catalogResult.stats, customResult.stats);
  const ok =
    headlines.length > 0 ||
    catalogResult.served === 'store' ||
    live.total === 0 ||
    live.succeeded > 0;
  return {
    headlines,
    feedStats: { ...live, served: catalogResult.served },
    status: ok ? 200 : 503,
  };
}

// POST branch: split server-authoritatively; catalog ids → store (client
// feedUrl ignored — closes the catalog SSRF vector); everything else → live.
export async function getHeadlinesForSources(requestedSources, { category = null, deps = {} } = {}) {
  const d = defaultDeps(deps);
  const catalogIds = [];
  const custom = [];
  for (const s of requestedSources) {
    if (s && typeof s.id === 'string' && catalogById.has(s.id)) catalogIds.push(s.id);
    else custom.push(s);
  }
  const [catalogResult, customResult] = await Promise.all([
    catalogIds.length > 0
      ? readCatalog(catalogIds, category, d)
      : Promise.resolve({ headlines: [], served: 'none', stats: ZERO_STATS }),
    custom.length > 0
      ? d.fetchFeeds(custom, { category })
      : Promise.resolve({ headlines: [], stats: ZERO_STATS }),
  ]);
  return finalize(catalogResult, customResult);
}

// GET branch: catalog only, filtered by category/source query params.
export async function getCatalogHeadlines({ category = null, source = null, deps = {} } = {}) {
  const d = defaultDeps(deps);
  let selected = catalog.sources;
  if (category) selected = selected.filter((s) => s.category === category);
  if (source) selected = selected.filter((s) => s.id === source);
  if (selected.length === 0) {
    return { headlines: [], feedStats: { ...ZERO_STATS, served: 'none' }, status: 200 };
  }
  const result = await readCatalog(selected.map((s) => s.id), category, d);
  return finalize(result, { headlines: [], stats: ZERO_STATS });
}
```

- [ ] **Step 4: Run** `npx vitest run lib/feedService.test.js lib/securityBoundary.test.js` — Expected: PASS, including the full boundary suite from Task 4 (all three tests now green).
- [ ] **Step 5: Commit** — `git add lib/feedService.js lib/feedService.test.js && git commit -m "feat: store-aware feed service — split, cold-vs-empty, single-flight fallback"`

---

### Task 9: Wire the service into `api/feeds.mjs` + `server.js` (guards preserved)

**Files:**
- Modify: `api/feeds.mjs` (replace body logic AFTER the guard chain; guards verbatim)
- Modify: `server.js` (GET + POST `/api/feeds` routes only)
- Test: `api/feeds.test.js`

**Interfaces:**
- Consumes: `getHeadlinesForSources`, `getCatalogHeadlines` (Task 8).
- Produces: unchanged HTTP contract `{ headlines, fetchedAt, cached, feedStats }` / error bodies. The GET path's old 5-minute in-memory cache is removed — the store IS the cache and the fallback slot is single-flight cached.

- [ ] **Step 1: Write the failing test** — `api/feeds.test.js` (mocks the service; exercises the real guard chain):

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/feedService.js', () => ({
  getHeadlinesForSources: vi.fn(),
  getCatalogHeadlines: vi.fn(),
}));
import { getHeadlinesForSources, getCatalogHeadlines } from '../lib/feedService.js';
import handler from './feeds.mjs';

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}
const SRC = { id: 'daily-star', feedUrl: 'https://x.example/f.xml' };
function post(body, ip = '10.9.9.9') {
  return { method: 'POST', url: '/api/feeds', headers: { host: 'test', 'x-forwarded-for': ip }, body };
}

beforeEach(() => {
  vi.mocked(getHeadlinesForSources).mockReset().mockResolvedValue({ headlines: [], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
  vi.mocked(getCatalogHeadlines).mockReset().mockResolvedValue({ headlines: [], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
});

describe('guard chain preserved (spec §5.2)', () => {
  it('OPTIONS → 204', async () => {
    const res = fakeRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    expect(res.statusCode).toBe(204);
  });
  it('400 on missing/empty sources and invalid JSON', async () => {
    let res = fakeRes();
    await handler(post({}), res);
    expect(res.statusCode).toBe(400);
    res = fakeRes();
    await handler(post('{not json', '10.9.9.8'), res);
    expect(res.statusCode).toBe(400);
  });
  it('400 past the 30-source cap', async () => {
    const res = fakeRes();
    await handler(post({ sources: Array.from({ length: 31 }, (_, i) => ({ id: `s${i}` })) }, '10.9.9.7'), res);
    expect(res.statusCode).toBe(400);
    expect(getHeadlinesForSources).not.toHaveBeenCalled();
  });
  it('429 past 60 requests/60s from one IP', async () => {
    let last;
    for (let i = 0; i < 61; i++) {
      last = fakeRes();
      await handler(post({ sources: [SRC] }, '10.1.2.3'), last);
    }
    expect(last.statusCode).toBe(429);
  });
});

describe('service wiring', () => {
  it('POST returns the contract shape and passes sources + category through', async () => {
    vi.mocked(getHeadlinesForSources).mockResolvedValue({ headlines: [{ id: 'x' }], feedStats: { total: 0, succeeded: 0, failed: 0, served: 'store' }, status: 200 });
    const res = fakeRes();
    await handler(post({ sources: [SRC], category: 'tech' }, '10.9.9.6'), res);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['cached', 'feedStats', 'fetchedAt', 'headlines']);
    expect(getHeadlinesForSources).toHaveBeenCalledWith([SRC], { category: 'tech' });
  });
  it('POST surfaces a 503 from the service as 503 with empty headlines', async () => {
    vi.mocked(getHeadlinesForSources).mockResolvedValue({ headlines: [], feedStats: { total: 1, succeeded: 0, failed: 1, served: 'error' }, status: 503 });
    const res = fakeRes();
    await handler(post({ sources: [SRC] }, '10.9.9.5'), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.headlines).toEqual([]);
  });
  it('GET routes through getCatalogHeadlines with query params', async () => {
    const res = fakeRes();
    await handler({ method: 'GET', url: '/api/feeds?category=tech&source=techcrunch', headers: { host: 'test', 'x-forwarded-for': '10.9.9.4' } }, res);
    expect(res.statusCode).toBe(200);
    expect(getCatalogHeadlines).toHaveBeenCalledWith({ category: 'tech', source: 'techcrunch' });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run api/feeds.test.js` — Expected: FAIL (handler still calls `fetchAllFeeds`; shape mismatches).
- [ ] **Step 3: Rewrite** `api/feeds.mjs` — guard chain identical, body logic swapped:

```js
import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { getHeadlinesForSources, getCatalogHeadlines } from '../lib/feedService.js';

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { allowed } = await checkRateLimit(`feeds:${clientIp(req)}`, { limit: 60, windowSec: 60 });
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  // POST: custom source list from user
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    const { sources: customSources, category } = body || {};
    if (!customSources || !Array.isArray(customSources) || customSources.length === 0) {
      return res.status(400).json({ error: 'sources array is required' });
    }
    if (customSources.length > 30) {
      return res.status(400).json({ error: 'Too many sources (max 30)' });
    }
    try {
      const { headlines, feedStats, status } = await getHeadlinesForSources(customSources, { category: category || null });
      if (status !== 200) {
        return res.status(status).json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats });
      }
      return res.status(200).json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
    } catch (err) {
      console.error('Feed fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
    }
  }

  // GET: catalog sources (store-served; live fallback only when globally cold)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const category = url.searchParams.get('category') || null;
  const source = url.searchParams.get('source') || null;
  try {
    const { headlines, feedStats, status } = await getCatalogHeadlines({ category, source });
    if (status !== 200) {
      return res.status(status).json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats });
    }
    return res.status(200).json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
  }
}
```

Note the wiring test asserts `getHeadlinesForSources` is called with `{ category: 'tech' }` — the handler passes `category || null`, so a present category is forwarded as-is and an absent one as `null`; the test for the call site uses `{ category: 'tech' }` which matches.

- [ ] **Step 4: Mirror in `server.js`** — replace the two `/api/feeds` routes (dev/prod parity, AGENTS landmine #1); other routes untouched; delete the now-unused module-level `cache`/`CACHE_TTL` and the unused `sources` require if nothing else uses it:

```js
app.get('/api/feeds', async (c) => {
  const category = c.req.query('category') || null;
  const source = c.req.query('source') || null;
  try {
    const { headlines, feedStats, status } = await getCatalogHeadlines({ category, source });
    if (status !== 200) {
      return c.json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats }, 503);
    }
    return c.json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return c.json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null }, 500);
  }
});

app.post('/api/feeds', async (c) => {
  const body = await c.req.json();
  const { sources: customSources, category } = body;
  if (!customSources || !Array.isArray(customSources) || customSources.length === 0) {
    return c.json({ error: 'sources array is required' }, 400);
  }
  if (customSources.length > 30) {
    return c.json({ error: 'Too many sources (max 30)' }, 400);
  }
  try {
    const { headlines, feedStats, status } = await getHeadlinesForSources(customSources, { category: category || null });
    if (status !== 200) {
      return c.json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats }, 503);
    }
    return c.json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return c.json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null }, 500);
  }
});
```

With imports at the top of `server.js`: `import { getHeadlinesForSources, getCatalogHeadlines } from './lib/feedService.js';` (and remove the now-unused `fetchAllFeeds` import if no other route uses it — `/api/extract` etc. keep their imports). The dev mirror also gains the 30-source cap the prod handler already had.

- [ ] **Step 5: Run** `npx vitest run api/feeds.test.js` then the full suite `npm test` — Expected: PASS / all green.
- [ ] **Step 6: Commit** — `git add api/feeds.mjs api/feeds.test.js server.js && git commit -m "feat: serve catalog feeds from the article store in prod and dev"`

---

### Task 10: IndexedDB re-key migration — `src/lib/db.js`

**Files:**
- Modify: `src/lib/db.js` (DB_VERSION 1 → 2; upgrade callback)
- Test: `src/lib/dbMigration.test.js` (new file — fresh module registry per file is required because `db.js` caches `dbPromise`)

**Interfaces:**
- Consumes: `articleId` (Task 1) — the browser-side reason it is pure JS.
- Produces: devices that saved favourites/history pre-2B have every record re-keyed to `articleId(record.url)` on first open; records whose url yields no id keep their old key (still readable). Public API of `db.js` unchanged.

- [ ] **Step 1: Write the failing test** — `src/lib/dbMigration.test.js`:

```js
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openDB } from 'idb';
import { articleId } from '../../lib/articleId.js';

describe('IndexedDB v2 re-key upgrade (spec D4 / Finding 10)', () => {
  it('re-keys pre-2B favourites and history to the shared articleId', async () => {
    const url = 'https://www.example.com/story?utm_source=mail';
    // Seed a v1 database exactly as a pre-2B device would have it.
    const v1 = await openDB('masthead', 1, {
      upgrade(db) {
        const articles = db.createObjectStore('articles', { keyPath: 'id' });
        articles.createIndex('savedAt', 'savedAt');
        articles.createIndex('isFavorite', 'isFavorite');
        articles.createIndex('sourceId', 'sourceId');
        const history = db.createObjectStore('history', { keyPath: 'id' });
        history.createIndex('readAt', 'readAt');
        db.createObjectStore('pending', { keyPath: 'url' });
      },
    });
    await v1.put('articles', { id: 'abc123def45600', url, title: 'Saved', isFavorite: true, savedAt: '2026-01-01T00:00:00.000Z' });
    await v1.put('history', { id: 'abc123def45600', url, title: 'Saved', readAt: '2026-01-02T00:00:00.000Z' });
    v1.close();

    const db = await import('./db.js'); // opens at v2 → upgrade runs
    const newId = articleId(url);
    const fav = await db.getFavorite(newId);
    expect(fav).toBeDefined();
    expect(fav.title).toBe('Saved');
    expect(fav.url).toBe(url); // url retained (spec §5.3)
    expect(await db.getFavorite('abc123def45600')).toBeUndefined();
    const history = await db.getAllHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(newId);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/dbMigration.test.js` — Expected: FAIL (db.js opens at version 1; no re-key).
- [ ] **Step 3: Implement.** In `src/lib/db.js`: add `import { articleId } from '../../lib/articleId.js';`, set `const DB_VERSION = 2;`, and replace the `upgrade` callback:

```js
      async upgrade(db, oldVersion, newVersion, tx) {
        // Saved articles (favorites)
        if (!db.objectStoreNames.contains('articles')) {
          const articleStore = db.createObjectStore('articles', { keyPath: 'id' });
          articleStore.createIndex('savedAt', 'savedAt');
          articleStore.createIndex('isFavorite', 'isFavorite');
          articleStore.createIndex('sourceId', 'sourceId');
        }

        // Reading history
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id' });
          historyStore.createIndex('readAt', 'readAt');
        }

        // Pending URLs from Siri Shortcut
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'url' });
        }

        // v2: one-time re-key of device-local records to the shared articleId
        // (2B spec D4) — without this, pre-2B favourites orphan when list ids
        // change scheme. Records whose url yields no id keep their old key.
        if (oldVersion >= 1 && oldVersion < 2) {
          for (const name of ['articles', 'history']) {
            const store = tx.objectStore(name);
            const records = await store.getAll();
            for (const record of records) {
              const newId = articleId(record.url);
              if (!newId || newId === record.id) continue;
              await store.delete(record.id);
              await store.put({ ...record, id: newId });
            }
          }
        }
      },
```

(All awaited operations are IDB requests on the open versionchange transaction — `idb` keeps the transaction alive across them; no non-IDB awaits are allowed inside.)

- [ ] **Step 4: Run** `npx vitest run src/lib/dbMigration.test.js src/lib/db.test.js` — Expected: PASS (fresh installs take the `oldVersion === 0` path: stores created, no re-key loop).
- [ ] **Step 5: Commit** — `git add src/lib/db.js src/lib/dbMigration.test.js && git commit -m "feat: one-time IndexedDB re-key to the shared article identity"`

---

### Task 11: Config + env + bundle guard — `vercel.json`, `.env.example`, `scripts/check-bundle.mjs`

**Files:**
- Modify: `vercel.json` (add `regions`, `crons`, poll function; headers/rewrites untouched)
- Modify: `.env.example`
- Create: `scripts/check-bundle.mjs`

**Interfaces:**
- Produces: Vercel Cron `*/20 * * * *` hitting `/api/cron/poll` (Production only, auto-sends `Authorization: Bearer $CRON_SECRET`); poller `maxDuration` 60. **Documented deviation from spec §3.1:** `vercel.json`'s `functions` block does not support per-function `regions`, so the region pin is project-wide `"regions": ["bom1"]` — acceptable because the userbase and the latency-critical feeds (Daily Star/TBS) are BD-side; noted for the PR description.

- [ ] **Step 1: Edit `vercel.json`** — final content:

```json
{
  "regions": ["bom1"],
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://*.supabase.co; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'"
        },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
        { "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains; preload" }
      ]
    }
  ],
  "crons": [{ "path": "/api/cron/poll", "schedule": "*/20 * * * *" }],
  "functions": {
    "api/feeds.mjs": { "maxDuration": 30 },
    "api/extract.mjs": { "maxDuration": 30 },
    "api/save-url.mjs": { "maxDuration": 15 },
    "api/discover-rss.mjs": { "maxDuration": 15 },
    "api/cron/poll.mjs": { "maxDuration": 60 }
  }
}
```

(The `headers` block is byte-identical to today's — verify with `git diff vercel.json` that only `regions`, `crons`, and the poll `functions` entry changed.)

- [ ] **Step 2: Append to `.env.example`:**

```bash
# --- 2B server-side store (non-VITE_ = never exposed to the browser) ---
SUPABASE_URL=
SUPABASE_ANON_KEY=
# Service-role key — write path (cron poller) only. NEVER VITE_-prefix this.
SUPABASE_SERVICE_ROLE_KEY=
# Bearer secret Vercel Cron sends to /api/cron/poll (generate: openssl rand -hex 32)
CRON_SECRET=
```

- [ ] **Step 3: Create `scripts/check-bundle.mjs`** (run after any production build; enforces spec §6 "built bundle has no service-role key"):

```js
// Post-build guard: the client bundle must never contain the service-role key
// or its env name. Run: npm run build && node scripts/check-bundle.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist/assets';
const markers = ['SUPABASE_SERVICE_ROLE_KEY'];
const keyValue = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (keyValue) markers.push(keyValue);

let scanned = 0;
let files;
try {
  files = readdirSync(DIST);
} catch {
  console.error(`FAIL: ${DIST} not found — run "npm run build" first`);
  process.exit(1);
}
for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const content = readFileSync(join(DIST, f), 'utf8');
  scanned += 1;
  for (const marker of markers) {
    if (content.includes(marker)) {
      console.error(`FAIL: dist/assets/${f} contains a service-role marker`);
      process.exit(1);
    }
  }
}
if (scanned === 0) {
  console.error('FAIL: no JS bundles found in dist/assets');
  process.exit(1);
}
console.log(
  `OK: ${scanned} bundle file(s) clean` +
    (keyValue ? ' (checked env-name AND live key value)' : ' (env key unset; env-name marker only)')
);
```

- [ ] **Step 4: Verify** — Run: `npm run build` (Expected: exit 0) then `node scripts/check-bundle.mjs` (Expected: `OK: N bundle file(s) clean...`, exit 0).
- [ ] **Step 5: Commit** — `git add vercel.json .env.example scripts/check-bundle.mjs && git commit -m "chore: cron schedule, bom1 region, server env docs, bundle leak guard"`

---

### Task 12: Full gates (proof-of-done)

**Files:** none (verification only).

- [ ] **Step 1:** Run `npm test` bare — Expected: exit 0, ALL tests pass (68 pre-existing + every new suite). Cite the count and exit code.
- [ ] **Step 2:** Run `npm run build` bare — Expected: exit 0. Then `node scripts/check-bundle.mjs` — Expected: exit 0.
- [ ] **Step 3:** Run `npx eslint src lib api server.js scripts` bare — Expected: exit 1 with EXACTLY the 3 baseline `set-state-in-effect` errors (`src/` components, pre-existing); zero new errors or warnings attributable to 2B files. If any new finding appears, fix it before proceeding.
- [ ] **Step 4:** `git status --short` — Expected: clean tree (everything committed).

---

### Task 13: Pre-flight authorization + rollout (OWNER GATE — one enumerated approval)

**Files:** none locally. Prod actions only, in spec §7 order. **STOP and present this exact list for one approval before executing any of it** (CLAUDE.md pre-flight rule):

1. **Supabase prod** (project `helavgnmsednyivsprrp`): determine the default-privilege regime (query `information_schema` / `pg_default_acl`), then apply `supabase/migrations/20260718_create_articles.sql`. Verify with `get_advisors(security)` → no `rls_disabled_in_public`; live anon INSERT attempt → rejected.
2. **Vercel env** (project `prj_YS5zYnfB7gT0vefuNuyxuoercH3Q`, team `team_qxLKCpN2yQ5U5lLOhquSOz1I`): add `SUPABASE_URL` + `SUPABASE_ANON_KEY` (Production + Preview), `SUPABASE_SERVICE_ROLE_KEY` + `CRON_SECRET` (Production only; `CRON_SECRET` = fresh `openssl rand -hex 32`).
3. **Deploy** the `phase2-2b` branch (order matters: table + keys exist before the poller's first run).
4. **Trigger** the first poll immediately: `vercel crons run /api/cron/poll` (or curl with the bearer) rather than waiting ≤20 min.
5. **Verify live** (deploy ≠ merge ≠ done): store row count > 0; `/api/feeds` POST returns `feedStats.served: "store"` (genuinely store-served, not silent fallback); anon write rejected via REST; freshness read works: `curl "https://<SUPABASE_URL>/rest/v1/articles?select=updated_at&order=updated_at.desc&limit=1" -H "apikey: <ANON_KEY>"`; both themes + PWA intact on `masthead-news.vercel.app`; security headers unchanged; a forced bad-secret request → 401.

---

### Task 14: Security review (Opus) + ship

- [ ] **Step 1:** Dispatch a fresh-context **Opus** security review (house routing: ALL security review goes to Opus) covering: the RLS migration, `lib/supabaseAdmin.js` + import boundary, `api/cron/poll.mjs` auth, `lib/articlesRepo.js` query posture, and the preserved `/api/feeds` guards. Fix CRITICAL/HIGH findings before PR.
- [ ] **Step 2:** Push `phase2-2b`, open the PR via `/ship` flow (`gh pr checks --watch`; per-action merge approval). PR prose describes the guards enforced — never an open-hole timeline (public repo, AGENTS landmine #10).
- [ ] **Step 3:** After merge: verify prod again on `masthead-news.vercel.app` (Task 13 §5 checks), then `/save-session`.

---

## Self-Review Notes (writing-plans checklist)

- **Spec coverage:** D1 (headlines-only: schema/poller store metadata only) → Tasks 3, 6, 7. D2 (cron */20, Pro) → Task 11. D3 (hybrid custom) → Task 8. D4 (shared pure-JS id + re-key) → Tasks 1, 2, 10. D5 (14-day, no cap) → Task 6 prune + no cap anywhere. D6 (RLS + grants + service-role-only writes) → Tasks 3, 4, 13. §5.1 poller order → Task 7. §5.2 guard preservation + cold-vs-empty + single-flight → Tasks 8, 9. §6 boundary tests + bundle scan + env invariant → Tasks 4, 11. §7 rollout order → Task 13. §8 DoD test list → mapped 1:1 across task tests; anon-write-rejected is live verification in Task 13 (cannot be a unit test without prod creds).
- **Known deviation (flagged):** per-function `regions` unsupported in `vercel.json` `functions` → project-wide `"regions": ["bom1"]` (Task 11 rationale).
- **Freshness read (spec §5.1 health):** satisfied by the public-SELECT REST query documented in Task 13 §5 — no extra endpoint (YAGNI).
- **Type consistency check:** `articleId` null-contract consumed consistently (Task 2 `continue`, Task 6 filter, Task 10 keep-old-key); headline camelCase shape asserted equal between repo and `mapFeedItems` (Task 5 test); `feedStats` `{ total, succeeded, failed, served }` produced by Task 8, passed through by Task 9.
