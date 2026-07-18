# Phase 2 · Slice 2C — Read-it-later Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One unified Saved library — paste a link, share from the OS, or heart a headline; every save fetches and files the full article body (device IndexedDB always; RLS-private `user_saved_articles` cloud rows when signed in).

**Architecture:** Client-orchestrated (spec D5): all channels converge on `src/lib/library.js#saveArticle`, which reuses the existing `/api/extract` (no server changes at all), writes local-first to the existing IndexedDB `articles` store, and upserts to the new cloud table under the user's own JWT. `src/lib/sync.js` gains a three-pass reconciler (tombstones → set-difference → intersection, body-beats-shell). Reader branches on content-presence, not record-presence.

**Tech Stack:** React 19 + Vite PWA (vite-plugin-pwa manifest `share_target`), idb 8 + fake-indexeddb (tests), supabase-js under user JWT, vitest 4. No new dependency.

**Spec:** `docs/superpowers/specs/2026-07-18-phase2-2c-read-it-later-design.md` (hardened — §12 lists the 14 review findings this plan MUST preserve the fixes for).

## Global Constraints

- **No `api/*` or `server.js` change.** The slice is client + SQL only.
- **No new npm dependency; no env-var change; no CSP change.**
- **Local discriminator:** every save sets `isFavorite: true` on the IndexedDB record (the existing `getAllFavorites()` filter is the Saved list's query) plus `savedVia: 'feed' | 'url' | 'share' | 'sync'`.
- **Identity:** caller-supplied headline `id` wins; `articleId(url)` only for paste/share; reject only when both absent (spec §3 — link-less feed items stay heartable).
- **Cloud shell upserts are metadata-only** — a row payload with `content: null` must OMIT the `content`/`content_truncated` keys so ON CONFLICT can never null a stored body (spec §4 step 5).
- **Deletes are tombstones** (`deleted_at` set via update/upsert), never row deletes; re-save revives with `deleted_at: null` (spec §7).
- **Client stamps `updated_at`** on every cloud write; local records carry `updatedAtLocal` for the reconciler.
- **Content cap:** 1,500,000 chars client-side (`contentTruncated: true` beyond); DB CHECK is 1,600,000.
- **Extraction queue:** sequential, ≥3s spacing, one 429 retry after backoff; failure → `bodyFailed` shell, never a thrown save.
- **Migration order (spec §9):** migration 1 (create + filtered copy) → deploy + verify → migration 2 (drop `user_favorites`). Two separate SQL files.
- **Gates run bare** (never piped). Lint baseline: 3 pre-existing `set-state-in-effect` errors, zero new. Suite baseline: 121 tests green.
- **Prod actions only in Task 10 after one enumerated pre-flight approval.** Public-repo prose: guards, never open holes.

---

### Task 1: Migrations (two files, applied at different rollout steps)

**Files:**
- Create: `supabase/migrations/20260719_create_user_saved_articles.sql`
- Create: `supabase/migrations/20260719_drop_user_favorites.sql`

**Interfaces:**
- Produces: `public.user_saved_articles` — columns consumed by Task 3's row mappers: `user_id uuid, article_id text, url text, title text, byline text, excerpt text, content text, content_truncated bool, lead_image text, word_count int, source_id text, source_name text, source_color text, is_paywall bool, saved_at timestamptz, updated_at timestamptz, deleted_at timestamptz`.

- [ ] **Step 1: Write migration 1** — `supabase/migrations/20260719_create_user_saved_articles.sql`:

```sql
-- Phase 2 Slice 2C: per-user read-it-later library (spec §3).
-- Owner-only rows via RLS; the client writes under the user's own JWT.
create table public.user_saved_articles (
  user_id      uuid not null references auth.users (id) on delete cascade,
  article_id   text not null,
  url          text not null check (url ~* '^https?://'),
  title        text,
  byline       text,
  excerpt      text,
  content      text,
  content_truncated boolean not null default false,
  lead_image   text,
  word_count   integer,
  source_id    text,
  source_name  text,
  source_color text,
  is_paywall   boolean not null default false,
  saved_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, article_id),
  constraint content_size check (content is null or length(content) <= 1600000)
);

create index user_saved_articles_user_saved_idx
  on public.user_saved_articles (user_id, saved_at desc);

-- Explicit privilege baseline, correct under both Supabase default-privilege
-- regimes. RLS enabled; policies below are the only access path for api roles.
alter table public.user_saved_articles enable row level security;
revoke all on table public.user_saved_articles from public, anon, authenticated;
grant select, insert, update, delete on table public.user_saved_articles to authenticated;
grant select, insert, update, delete on table public.user_saved_articles to service_role;

create policy "saved select own" on public.user_saved_articles
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "saved insert own" on public.user_saved_articles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "saved update own" on public.user_saved_articles
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "saved delete own" on public.user_saved_articles
  for delete to authenticated using ((select auth.uid()) = user_id);
-- No policies for anon; UPDATE carries USING + WITH CHECK so user_id can never
-- be reassigned.

-- Carry existing favorites over as metadata shells. Filtered so a legacy row
-- with an invalid url cannot abort the transaction (spec §12); thumbnail maps
-- to lead_image; category is not part of the library model.
insert into public.user_saved_articles
  (user_id, article_id, url, title, excerpt, lead_image, source_id, source_name, saved_at)
select user_id, article_id, url, title, excerpt, thumbnail, source_id, source_name,
       coalesce(saved_at, now())
from public.user_favorites
where url ~* '^https?://'
on conflict (user_id, article_id) do nothing;
```

- [ ] **Step 2: Write migration 2** — `supabase/migrations/20260719_drop_user_favorites.sql`:

```sql
-- Phase 2 Slice 2C rollout step 4 (spec §9): apply ONLY after the 2C app
-- deploy is live-verified. Until then the previous app version still syncs
-- favorites against this table.
drop table if exists public.user_favorites;
```

- [ ] **Step 3: Sanity-check** — Run: `node -e "const fs=require('fs');const a=fs.readFileSync('supabase/migrations/20260719_create_user_saved_articles.sql','utf8');if(!/enable row level security/.test(a)||!/revoke all/.test(a)||!/with check/.test(a)||!/where url ~\\* '\\^https\\?:\\/\\/'/.test(a))process.exit(1);console.log('ok')"` — Expected: `ok`.
- [ ] **Step 4: Commit** — `git add supabase/migrations/20260719_create_user_saved_articles.sql supabase/migrations/20260719_drop_user_favorites.sql && git commit -m "feat: user_saved_articles migration pair — RLS owner-only, filtered copy, deferred drop"`

---

### Task 2: `patchSavedArticle` helper — `src/lib/db.js`

**Files:**
- Modify: `src/lib/db.js` (append near the other favorites helpers, after `isFavorited`)
- Test: `src/lib/db.test.js` (extend)

**Interfaces:**
- Produces: `patchSavedArticle(id: string, patch: object) → Promise<record|null>` — merges `patch` into the existing record, stamps `updatedAtLocal` (ISO string), returns the merged record; null when the id is absent. Consumed by Tasks 3, 4, 6.

- [ ] **Step 1: Write the failing test** — append to `src/lib/db.test.js`:

```js
import { saveFavorite, getFavorite, patchSavedArticle } from './db.js';

describe('patchSavedArticle', () => {
  it('merges fields, stamps updatedAtLocal, preserves the rest', async () => {
    await saveFavorite({ id: 'p1', url: 'https://x.example/a', title: 'T', pendingBody: true });
    const patched = await patchSavedArticle('p1', { content: '<p>b</p>', pendingBody: false });
    expect(patched.content).toBe('<p>b</p>');
    expect(patched.pendingBody).toBe(false);
    expect(patched.title).toBe('T');
    expect(typeof patched.updatedAtLocal).toBe('string');
    const roundTrip = await getFavorite('p1');
    expect(roundTrip.content).toBe('<p>b</p>');
  });
  it('returns null for an unknown id', async () => {
    expect(await patchSavedArticle('nope', { a: 1 })).toBeNull();
  });
});
```

(Note: `db.test.js` currently imports only `putHistoryEntry, getAllHistory` — extend that import line accordingly.)

- [ ] **Step 2: Run** `npx vitest run src/lib/db.test.js` — Expected: FAIL (`patchSavedArticle` not exported).
- [ ] **Step 3: Implement** — append to `src/lib/db.js` after `isFavorited`:

```js
export async function patchSavedArticle(id, patch) {
  const db = await getDB();
  const existing = await db.get('articles', id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAtLocal: new Date().toISOString() };
  await db.put('articles', updated);
  return updated;
}
```

- [ ] **Step 4: Run** `npx vitest run src/lib/db.test.js src/lib/dbMigration.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/lib/db.js src/lib/db.test.js && git commit -m "feat: patchSavedArticle merge helper with local update stamp"`

---

### Task 3: Sync rework — `src/lib/sync.js` three-pass saved sync

**Files:**
- Modify: `src/lib/sync.js` (replace the favorites section of `syncOnSignIn` and the `pushFavorite`/`removeFavoriteRemote` functions; history + sources sections untouched)
- Test: `src/lib/sync.test.js` (extend; keep the existing `buildSourceRows` tests)

**Interfaces:**
- Consumes: `getAllFavorites, saveFavorite, removeFavorite, patchSavedArticle` from `./db` (Task 2).
- Produces (consumed by Tasks 4, 6, 7): `pushSaved(userId, record) → Promise<void>` (metadata-only when `record.content` is falsy; always sends `updated_at` + `deleted_at: null`); `removeSaved(userId, { id, url }) → Promise<void>` (tombstone upsert when url is http(s), update-only otherwise); `savedRowFromLocal(userId, f) → row`; `localFromSavedRow(r) → record`; reworked `syncOnSignIn`.

- [ ] **Step 1: Write the failing tests** — replace `src/lib/sync.test.js` with:

```js
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertCalls = [];
const updateCalls = [];
let cloudRows = [];

vi.mock('./supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => ({ eq: () => Promise.resolve({ data: table === 'user_saved_articles' ? cloudRows : [] }) }),
      upsert: (rows, opts) => { upsertCalls.push({ table, rows, opts }); return Promise.resolve({ error: null }); },
      update: (patch) => ({ eq: () => ({ eq: () => { updateCalls.push({ table, patch }); return Promise.resolve({ error: null }); } }) }),
      delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }),
  },
}));

import { buildSourceRows, pushSaved, removeSaved, savedRowFromLocal, localFromSavedRow, syncOnSignIn } from './sync.js';
import { saveFavorite, getAllFavorites, getFavorite } from './db.js';
import sourcesData from '../../lib/sources.json';

const LOCAL = (over = {}) => ({
  id: 'a'.repeat(16), url: 'https://x.example/a', title: 'T', excerpt: 'e',
  content: '<p>body</p>', contentTruncated: false, leadImage: null, wordCount: 5,
  sourceId: 's1', sourceName: 'S', sourceColor: '#000', isPaywall: false,
  savedAt: '2026-07-01T00:00:00.000Z', updatedAtLocal: '2026-07-02T00:00:00.000Z', ...over,
});
const CLOUD = (over = {}) => ({
  article_id: 'a'.repeat(16), url: 'https://x.example/a', title: 'T', byline: null, excerpt: 'e',
  content: '<p>cloud</p>', content_truncated: false, lead_image: null, word_count: 5,
  source_id: 's1', source_name: 'S', source_color: '#000', is_paywall: false,
  saved_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T12:00:00.000Z', deleted_at: null, ...over,
});

beforeEach(() => { upsertCalls.length = 0; updateCalls.length = 0; cloudRows = []; });

describe('buildSourceRows (unchanged)', () => {
  it('maps only the selected known source ids to user_sources rows', () => {
    const first = sourcesData.sources[0];
    const rows = buildSourceRows('user-1', [first.id, 'nonexistent-id']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'user-1', source_id: first.id, name: first.name });
  });
});

describe('pushSaved', () => {
  it('sends the full row for a body-bearing record, with updated_at + deleted_at null', async () => {
    await pushSaved('u1', LOCAL());
    const { table, rows } = upsertCalls[0];
    expect(table).toBe('user_saved_articles');
    expect(rows.content).toBe('<p>body</p>');
    expect(rows.deleted_at).toBeNull();
    expect(typeof rows.updated_at).toBe('string');
  });
  it('OMITS content columns for a shell so ON CONFLICT can never null a stored body', async () => {
    await pushSaved('u1', LOCAL({ content: null }));
    const { rows } = upsertCalls[0];
    expect('content' in rows).toBe(false);
    expect('content_truncated' in rows).toBe(false);
    expect(rows.title).toBe('T');
  });
});

describe('removeSaved', () => {
  it('tombstones via upsert (deleted_at set) when the record has an http(s) url', async () => {
    await removeSaved('u1', { id: 'x'.repeat(16), url: 'https://x.example/a' });
    const { rows } = upsertCalls[0];
    expect(typeof rows.deleted_at).toBe('string');
    expect(rows.article_id).toBe('x'.repeat(16));
  });
  it('falls back to update-only for a link-less record', async () => {
    await removeSaved('u1', { id: 'y'.repeat(16), url: '' });
    expect(upsertCalls).toHaveLength(0);
    expect(typeof updateCalls[0].patch.deleted_at).toBe('string');
  });
});

describe('syncOnSignIn three-pass merge', () => {
  it('pass 1: a cloud tombstone removes the local copy and is never re-pushed', async () => {
    await saveFavorite(LOCAL({ id: 'd'.repeat(16), url: 'https://x.example/del' }));
    cloudRows = [CLOUD({ article_id: 'd'.repeat(16), url: 'https://x.example/del', deleted_at: '2026-07-03T00:00:00.000Z' })];
    await syncOnSignIn('u1');
    expect(await getFavorite('d'.repeat(16))).toBeUndefined();
    for (const c of upsertCalls) {
      const arr = Array.isArray(c.rows) ? c.rows : [c.rows];
      expect(arr.some((r) => r.article_id === 'd'.repeat(16))).toBe(false);
    }
  });
  it('pass 2: pushes local-only records up and pulls live cloud-only records down', async () => {
    await saveFavorite(LOCAL({ id: 'l'.repeat(16), url: 'https://x.example/local' }));
    cloudRows = [CLOUD({ article_id: 'c'.repeat(16), url: 'https://x.example/cloud' })];
    await syncOnSignIn('u1');
    const pushed = upsertCalls.flatMap((c) => (Array.isArray(c.rows) ? c.rows : [c.rows]));
    expect(pushed.some((r) => r.article_id === 'l'.repeat(16))).toBe(true);
    const pulled = await getFavorite('c'.repeat(16));
    expect(pulled.content).toBe('<p>cloud</p>');
    expect(pulled.isFavorite).toBe(true);
  });
  it('pass 3: body beats shell in BOTH directions', async () => {
    await saveFavorite(LOCAL({ id: 'b'.repeat(16), url: 'https://x.example/b' })); // local body
    cloudRows = [
      CLOUD({ article_id: 'b'.repeat(16), url: 'https://x.example/b', content: null }), // cloud shell
      CLOUD({ article_id: 'e'.repeat(16), url: 'https://x.example/e' }), // cloud body
    ];
    await saveFavorite(LOCAL({ id: 'e'.repeat(16), url: 'https://x.example/e', content: null })); // local shell
    await syncOnSignIn('u1');
    const pushed = upsertCalls.flatMap((c) => (Array.isArray(c.rows) ? c.rows : [c.rows]));
    expect(pushed.some((r) => r.article_id === 'b'.repeat(16) && r.content === '<p>body</p>')).toBe(true);
    const upgraded = await getFavorite('e'.repeat(16));
    expect(upgraded.content).toBe('<p>cloud</p>');
    expect(upgraded.bodyFailed).toBe(false);
  });
  it('pass 3: two bodies → newer updated_at wins (cloud newer pulls down)', async () => {
    await saveFavorite(LOCAL({ id: 'n'.repeat(16), url: 'https://x.example/n', updatedAtLocal: '2026-07-01T00:00:00.000Z' }));
    cloudRows = [CLOUD({ article_id: 'n'.repeat(16), url: 'https://x.example/n', content: '<p>newer</p>', updated_at: '2026-07-05T00:00:00.000Z' })];
    await syncOnSignIn('u1');
    const local = await getFavorite('n'.repeat(16));
    expect(local.content).toBe('<p>newer</p>');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/sync.test.js` — Expected: FAIL (`pushSaved` etc. not exported).
- [ ] **Step 3: Implement.** In `src/lib/sync.js`: change the db import to `import { getAllFavorites, getAllHistory, saveFavorite, putHistoryEntry, removeFavorite, patchSavedArticle } from './db';`. REPLACE the bodies of `pushFavorite`/`removeFavoriteRemote` with the interim wrappers below (deleted in Task 5). ADD the row mappers + `pushSaved` + `removeSaved`:

```js
// Interim back-compat until Task 5 rewires FavoriteToggle (keeps every commit
// buildable): pushFavorite/removeFavoriteRemote become thin wrappers, deleted
// in Task 5.
export async function pushFavorite(userId, article) {
  return pushSaved(userId, article);
}
export async function removeFavoriteRemote(userId, articleId) {
  return removeSaved(userId, { id: articleId, url: '' });
}

function savedRowFromLocal(userId, f) {
  return {
    user_id: userId,
    article_id: f.id,
    url: f.url,
    title: f.title ?? null,
    byline: f.byline ?? null,
    excerpt: f.excerpt ?? null,
    content: f.content ?? null,
    content_truncated: !!f.contentTruncated,
    lead_image: f.leadImage ?? f.thumbnail ?? null,
    word_count: f.wordCount ?? null,
    source_id: f.sourceId ?? null,
    source_name: f.sourceName ?? null,
    source_color: f.sourceColor ?? null,
    is_paywall: !!f.isPaywall,
    saved_at: f.savedAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
}

function localFromSavedRow(r) {
  return {
    id: r.article_id,
    url: r.url,
    title: r.title,
    byline: r.byline,
    excerpt: r.excerpt,
    content: r.content,
    contentTruncated: !!r.content_truncated,
    leadImage: r.lead_image,
    thumbnail: r.lead_image,
    wordCount: r.word_count,
    sourceId: r.source_id,
    sourceName: r.source_name,
    sourceColor: r.source_color,
    isPaywall: !!r.is_paywall,
    savedAt: r.saved_at,
    savedVia: 'sync',
    pendingBody: false,
    bodyFailed: !r.content,
  };
}

export { savedRowFromLocal, localFromSavedRow };

// Shell upserts are metadata-only: omitting the content keys means ON CONFLICT
// leaves any stored body untouched (spec §4 step 5 / review HIGH).
export async function pushSaved(userId, record) {
  if (!supabase || !userId) return;
  try {
    const row = savedRowFromLocal(userId, record);
    if (!record.content) {
      delete row.content;
      delete row.content_truncated;
    }
    await supabase
      .from('user_saved_articles')
      .upsert(row, { onConflict: 'user_id,article_id' });
  } catch (err) {
    console.error('[sync] push saved error:', err);
  }
}

// Delete = tombstone, never a row delete, so a stale peer cannot resurrect it
// (spec §7 pass 1). A link-less record can't satisfy the url CHECK, so it
// falls back to update-only (no-op if the row never synced).
export async function removeSaved(userId, { id, url }) {
  if (!supabase || !userId) return;
  const stamp = new Date().toISOString();
  try {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await supabase.from('user_saved_articles').upsert(
        { user_id: userId, article_id: id, url, deleted_at: stamp, updated_at: stamp },
        { onConflict: 'user_id,article_id' }
      );
    } else {
      await supabase
        .from('user_saved_articles')
        .update({ deleted_at: stamp, updated_at: stamp })
        .eq('user_id', userId)
        .eq('article_id', id);
    }
  } catch (err) {
    console.error('[sync] remove saved error:', err);
  }
}
```

(Place the wrappers AFTER the `pushSaved`/`removeSaved` definitions they call.) Then REPLACE the favorites section of `syncOnSignIn` (lines 9–51 in the current file — everything from `// Sync favorites` through the `toDownload` loop) with:

```js
    // Saved-articles sync: three passes (spec §7).
    const localSaved = await getAllFavorites();
    const { data: cloudData } = await supabase
      .from('user_saved_articles')
      .select('*')
      .eq('user_id', userId);
    const cloud = cloudData || [];
    const cloudById = new Map(cloud.map((r) => [r.article_id, r]));
    const localById = new Map(localSaved.map((f) => [f.id, f]));

    // Pass 1: cloud tombstones are authoritative — drop local copies, never re-push.
    for (const r of cloud) {
      if (r.deleted_at && localById.has(r.article_id)) {
        await removeFavorite(r.article_id);
        localById.delete(r.article_id);
      }
    }

    // Pass 2: set difference. Push local-only (bodies included); pull live cloud-only.
    const toUpload = [...localById.values()].filter((f) => !cloudById.has(f.id));
    if (toUpload.length > 0) {
      await supabase
        .from('user_saved_articles')
        .upsert(toUpload.map((f) => savedRowFromLocal(userId, f)), { onConflict: 'user_id,article_id' });
    }
    let pulled = 0;
    for (const r of cloud) {
      if (!r.deleted_at && !localById.has(r.article_id)) {
        await saveFavorite(localFromSavedRow(r));
        pulled += 1;
      }
    }

    // Pass 3: reconcile the intersection — a body always beats a shell; two
    // bodies (or two shells) → newer stamp wins (spec §7 / review HIGH).
    for (const r of cloud) {
      if (r.deleted_at) continue;
      const local = localById.get(r.article_id);
      if (!local) continue;
      const localHasBody = !!local.content;
      const cloudHasBody = !!r.content;
      const upgradeLocal = () =>
        patchSavedArticle(local.id, {
          title: r.title ?? local.title,
          byline: r.byline ?? local.byline ?? null,
          excerpt: r.excerpt ?? local.excerpt,
          content: r.content,
          contentTruncated: !!r.content_truncated,
          leadImage: r.lead_image ?? local.leadImage ?? null,
          wordCount: r.word_count ?? local.wordCount ?? null,
          pendingBody: false,
          bodyFailed: false,
        });
      if (localHasBody && !cloudHasBody) {
        await pushSaved(userId, local);
      } else if (!localHasBody && cloudHasBody) {
        await upgradeLocal();
      } else if (localHasBody && cloudHasBody) {
        const localAt = new Date(local.updatedAtLocal || local.savedAt || 0).getTime();
        const cloudAt = new Date(r.updated_at || 0).getTime();
        if (localAt > cloudAt) await pushSaved(userId, local);
        else if (cloudAt > localAt) await upgradeLocal();
      }
    }
```

Also update the final `console.log` line to `console.log(\`[sync] Saved: ${toUpload.length} up, ${pulled} down; history: ${histToUpload.length} up, ${histToDownload.length} down\`);` (the `toDownload` variable no longer exists).

- [ ] **Step 4: Run** `npx vitest run src/lib/sync.test.js` — Expected: PASS (8 tests). Then `npx vitest run src` — Expected: PASS except any file still importing `pushFavorite`/`removeFavoriteRemote` (that's `FavoriteToggle.jsx`, fixed in Task 5 — vitest only imports it via no test today, so the suite stays green).
- [ ] **Step 5: Commit** — `git add src/lib/sync.js src/lib/sync.test.js && git commit -m "feat: three-pass saved-articles sync with tombstones and body-beats-shell"`

---

### Task 4: The save pipeline — `src/lib/library.js`

**Files:**
- Create: `src/lib/library.js`
- Test: `src/lib/library.test.js`

**Interfaces:**
- Consumes: `articleId` (`../../lib/articleId.js`); `extractArticle` (`./api`); `saveFavorite, removeFavorite, getFavorite, patchSavedArticle, getPendingUrls, removePendingUrl` (`./db`); `pushSaved, removeSaved` (`./sync`); `useAuthStore` (`../stores/authStore`).
- Produces (consumed by Tasks 5–8): `saveArticle({ url, id?, sourceMeta?, savedVia?, preloadedArticle? }, deps?) → Promise<record>` (throws `LibrarySaveError` only on no-identity; extraction failure resolves to a `bodyFailed` shell); `retrySave(id, deps?) → Promise<record|null>`; `deleteSaved({ id, url }, deps?) → Promise<void>`; `attachBodyToSaved(id, article, deps?) → Promise<record|null>`; `processPendingSaves(deps?) → Promise<number>`; `resolveReaderSource(saved, url) → 'stored'|'live'|'shell'|'none'`; `firstHttpUrl(text) → string|null`; `capContent(content) → { content, contentTruncated }`; `LibrarySaveError`.

- [ ] **Step 1: Write the failing tests** — `src/lib/library.test.js`:

```js
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import {
  saveArticle, retrySave, deleteSaved, attachBodyToSaved, processPendingSaves,
  resolveReaderSource, firstHttpUrl, capContent, LibrarySaveError,
} from './library.js';
import { getFavorite, getAllFavorites, saveFavorite, addPendingUrl, getPendingUrls } from './db.js';
import { articleId } from '../../lib/articleId.js';

const BODY = { title: 'Full', byline: 'By A', excerpt: 'ex', content: '<p>body</p>', leadImage: null, wordCount: 9, readingTimeMinutes: 1 };
const noQueueWait = { spacingMs: 0, backoffMs: 0 };
const deps = (over = {}) => ({
  extract: vi.fn().mockResolvedValue(BODY),
  pushSavedFn: vi.fn().mockResolvedValue(undefined),
  removeSavedFn: vi.fn().mockResolvedValue(undefined),
  getUser: () => ({ id: 'u1' }),
  ...noQueueWait,
  ...over,
});

describe('helpers', () => {
  it('firstHttpUrl finds the first link in shared text, null otherwise', () => {
    expect(firstHttpUrl('look at https://x.example/a and more')).toBe('https://x.example/a');
    expect(firstHttpUrl('no links here')).toBeNull();
    expect(firstHttpUrl(null)).toBeNull();
  });
  it('capContent truncates beyond 1.5M chars and flags it', () => {
    const big = 'x'.repeat(1_500_001);
    const capped = capContent(big);
    expect(capped.content).toHaveLength(1_500_000);
    expect(capped.contentTruncated).toBe(true);
    expect(capContent('small')).toEqual({ content: 'small', contentTruncated: false });
  });
  it('resolveReaderSource: stored for body, live for shell-with-url, shell without url, none otherwise', () => {
    expect(resolveReaderSource({ content: '<p>x</p>' }, null)).toBe('stored');
    expect(resolveReaderSource({ textContent: 'x' }, null)).toBe('stored');
    expect(resolveReaderSource({ content: null }, 'https://x.example/a')).toBe('live');
    expect(resolveReaderSource({ content: null, url: '' }, null)).toBe('shell');
    expect(resolveReaderSource(undefined, null)).toBe('none');
  });
});

describe('saveArticle', () => {
  it('paste happy path: files intent, extracts, attaches body, pushes to cloud, sets discriminator', async () => {
    const d = deps();
    const record = await saveArticle({ url: 'https://x.example/story', savedVia: 'url' }, d);
    expect(record.id).toBe(articleId('https://x.example/story'));
    expect(record.isFavorite).toBe(true);
    expect(record.savedVia).toBe('url');
    expect(record.content).toBe('<p>body</p>');
    expect(record.pendingBody).toBe(false);
    expect(d.pushSavedFn).toHaveBeenCalledWith('u1', expect.objectContaining({ content: '<p>body</p>' }));
  });
  it('prefers the caller-supplied headline id (link-less feed items stay heartable)', async () => {
    const d = deps();
    const record = await saveArticle({ url: '', id: 'feedid1234567890', sourceMeta: { title: 'Linkless' }, savedVia: 'feed' }, d);
    expect(record.id).toBe('feedid1234567890');
    expect(d.extract).not.toHaveBeenCalled(); // no url to extract from
    expect(record.bodyFailed).toBe(true); // shell, but SAVED — not rejected
  });
  it('rejects only when both id and url are absent', async () => {
    await expect(saveArticle({ url: 'not a url' }, deps())).rejects.toBeInstanceOf(LibrarySaveError);
  });
  it('extraction failure files a bodyFailed shell and still pushes a metadata-only record', async () => {
    const d = deps({ extract: vi.fn().mockRejectedValue(new Error('boom')) });
    const record = await saveArticle({ url: 'https://x.example/fail' }, d);
    expect(record.bodyFailed).toBe(true);
    expect(record.content).toBeUndefined();
    expect(d.pushSavedFn).toHaveBeenCalledWith('u1', expect.objectContaining({ bodyFailed: true }));
  });
  it('heart-from-reader reuses the preloaded body — extract is never called', async () => {
    const d = deps();
    const record = await saveArticle(
      { url: 'https://x.example/read', savedVia: 'feed', preloadedArticle: BODY },
      d
    );
    expect(d.extract).not.toHaveBeenCalled();
    expect(record.content).toBe('<p>body</p>');
  });
  it('retries once after a 429 then succeeds', async () => {
    const d = deps({
      extract: vi.fn()
        .mockRejectedValueOnce(new Error('Extraction failed: 429'))
        .mockResolvedValueOnce(BODY),
    });
    const record = await saveArticle({ url: 'https://x.example/limited' }, d);
    expect(d.extract).toHaveBeenCalledTimes(2);
    expect(record.content).toBe('<p>body</p>');
  });
  it('logged-out: saves locally, never touches cloud', async () => {
    const d = deps({ getUser: () => null });
    await saveArticle({ url: 'https://x.example/anon' }, d);
    expect(d.pushSavedFn).not.toHaveBeenCalled();
    expect((await getFavorite(articleId('https://x.example/anon'))).content).toBe('<p>body</p>');
  });
  it('dedup: heart then paste of the same URL is one record', async () => {
    const d = deps();
    const url = 'https://x.example/same';
    await saveArticle({ url, id: articleId(url), savedVia: 'feed' }, d);
    await saveArticle({ url, savedVia: 'url' }, d);
    const all = await getAllFavorites();
    expect(all.filter((a) => a.url === url)).toHaveLength(1);
  });
});

describe('retrySave / attachBodyToSaved / deleteSaved / processPendingSaves', () => {
  it('retrySave re-extracts a failed shell and attaches the body', async () => {
    const failing = deps({ extract: vi.fn().mockRejectedValue(new Error('down')) });
    const shell = await saveArticle({ url: 'https://x.example/retry' }, failing);
    expect(shell.bodyFailed).toBe(true);
    const ok = deps();
    const record = await retrySave(shell.id, ok);
    expect(record.content).toBe('<p>body</p>');
    expect(record.bodyFailed).toBe(false);
  });
  it('attachBodyToSaved patches a shell with a live-fetched article and pushes it', async () => {
    await saveFavorite({ id: 'shellid123456789', url: 'https://x.example/att', title: 'S', pendingBody: false, bodyFailed: true });
    const d = deps();
    const record = await attachBodyToSaved('shellid123456789', BODY, d);
    expect(record.content).toBe('<p>body</p>');
    expect(d.pushSavedFn).toHaveBeenCalled();
  });
  it('deleteSaved removes locally and tombstones cloud for signed-in users', async () => {
    const d = deps();
    const saved = await saveArticle({ url: 'https://x.example/gone' }, d);
    await deleteSaved({ id: saved.id, url: saved.url }, d);
    expect(await getFavorite(saved.id)).toBeUndefined();
    expect(d.removeSavedFn).toHaveBeenCalledWith('u1', { id: saved.id, url: saved.url });
  });
  it('processPendingSaves drains the pending store through saveArticle', async () => {
    await addPendingUrl('https://x.example/pending1');
    const d = deps();
    const n = await processPendingSaves(d);
    expect(n).toBe(1);
    expect(await getPendingUrls()).toHaveLength(0);
    expect(await getFavorite(articleId('https://x.example/pending1'))).toBeDefined();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/library.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/lib/library.js`:

```js
import { articleId } from '../../lib/articleId.js';
import { extractArticle as apiExtract } from './api';
import {
  saveFavorite, removeFavorite, getFavorite, patchSavedArticle,
  getPendingUrls, removePendingUrl,
} from './db';
import { pushSaved, removeSaved } from './sync';
import useAuthStore from '../stores/authStore';

const MAX_CONTENT_CHARS = 1_500_000;
const QUEUE_SPACING_MS = 3000;
const RATE_LIMIT_BACKOFF_MS = 15000;

export class LibrarySaveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LibrarySaveError';
  }
}

export function firstHttpUrl(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : null;
}

export function capContent(content) {
  if (typeof content !== 'string') return { content: null, contentTruncated: false };
  if (content.length <= MAX_CONTENT_CHARS) return { content, contentTruncated: false };
  return { content: content.slice(0, MAX_CONTENT_CHARS), contentTruncated: true };
}

// The reader's saved-item branch keys on CONTENT-presence, not record-presence
// (spec §4 reader integration / review HIGH: shells must never dead-end).
export function resolveReaderSource(saved, url) {
  if (saved && (saved.content || saved.textContent)) return 'stored';
  if (url) return 'live';
  if (saved) return 'shell';
  return 'none';
}

function defaultDeps(deps) {
  return {
    extract: apiExtract,
    pushSavedFn: pushSaved,
    removeSavedFn: removeSaved,
    getUser: () => useAuthStore.getState().user,
    spacingMs: QUEUE_SPACING_MS,
    backoffMs: RATE_LIMIT_BACKOFF_MS,
    ...deps,
  };
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Sequential, paced extraction queue. Pacing bounds request rate (concurrency
// alone does not — spec §12); one backoff retry on 429, then the caller files
// a bodyFailed shell. Never throws.
let queueTail = Promise.resolve();
let lastRunAt = 0;
function extractQueued(url, sourceId, d) {
  const run = queueTail.then(async () => {
    await sleep(Math.max(0, lastRunAt + d.spacingMs - Date.now()));
    lastRunAt = Date.now();
    try {
      return await d.extract(url, sourceId);
    } catch (err) {
      if (String(err?.message).includes('429')) {
        await sleep(d.backoffMs);
        lastRunAt = Date.now();
        try {
          return await d.extract(url, sourceId);
        } catch {
          return null;
        }
      }
      return null;
    }
  });
  queueTail = run.catch(() => {});
  return run;
}

async function applyBody(id, body, shellTitle) {
  const { content, contentTruncated } = capContent(body.content);
  return patchSavedArticle(id, {
    title: body.title || shellTitle,
    byline: body.byline ?? null,
    excerpt: body.excerpt ?? '',
    content,
    contentTruncated,
    textContent: body.textContent ?? null,
    leadImage: body.leadImage ?? null,
    wordCount: body.wordCount ?? null,
    readingTimeMinutes: body.readingTimeMinutes ?? null,
    pendingBody: false,
    bodyFailed: false,
  });
}

async function pushIfSignedIn(record, d) {
  const user = d.getUser();
  if (user && record) await d.pushSavedFn(user.id, record);
}

// One pipeline, all channels (spec §4). Local-first: the shell is filed before
// extraction; failure downgrades to bodyFailed, never a lost save.
export async function saveArticle({ url, id, sourceMeta = {}, savedVia = 'url', preloadedArticle = null }, deps = {}) {
  const d = defaultDeps(deps);
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  const finalId = id || articleId(cleanUrl);
  if (!finalId) throw new LibrarySaveError('No link found to save');

  await saveFavorite({
    id: finalId,
    url: cleanUrl,
    title: sourceMeta.title || preloadedArticle?.title || cleanUrl || 'Saved item',
    sourceId: sourceMeta.sourceId ?? null,
    sourceName: sourceMeta.sourceName ?? null,
    sourceShortName: sourceMeta.sourceShortName ?? null,
    sourceColor: sourceMeta.sourceColor ?? null,
    category: sourceMeta.category ?? null,
    thumbnail: sourceMeta.thumbnail ?? null,
    excerpt: sourceMeta.excerpt ?? '',
    savedVia,
    pendingBody: true,
    bodyFailed: false,
  });

  let body = null;
  if (preloadedArticle && (preloadedArticle.content || preloadedArticle.textContent)) {
    body = preloadedArticle; // heart-from-reader: the app already holds the body
  } else if (/^https?:\/\//i.test(cleanUrl)) {
    body = await extractQueued(cleanUrl, sourceMeta.sourceId, d);
  }

  const record = body
    ? await applyBody(finalId, body, sourceMeta.title || cleanUrl)
    : await patchSavedArticle(finalId, { pendingBody: false, bodyFailed: true });

  await pushIfSignedIn(record, d);
  return record;
}

export async function retrySave(id, deps = {}) {
  const d = defaultDeps(deps);
  const saved = await getFavorite(id);
  if (!saved || !/^https?:\/\//i.test(saved.url || '')) return saved ?? null;
  const body = await extractQueued(saved.url, saved.sourceId, d);
  const record = body
    ? await applyBody(id, body, saved.title)
    : await patchSavedArticle(id, { pendingBody: false, bodyFailed: true });
  await pushIfSignedIn(record, d);
  return record;
}

// Reader helper: a live-fetched article for a saved shell gets attached so the
// item is offline-readable from then on.
export async function attachBodyToSaved(id, article, deps = {}) {
  const d = defaultDeps(deps);
  const saved = await getFavorite(id);
  if (!saved || saved.content) return saved ?? null;
  const record = await applyBody(id, article, saved.title);
  await pushIfSignedIn(record, d);
  return record;
}

// Delete = local remove + cloud tombstone; identical for un-heart and the
// Saved page (spec §6 / review HIGH: local-only delete resurrects).
export async function deleteSaved({ id, url }, deps = {}) {
  const d = defaultDeps(deps);
  await removeFavorite(id);
  const user = d.getUser();
  if (user) await d.removeSavedFn(user.id, { id, url: url ?? '' });
}

// Drains share-target URLs stashed while the app was gated (spec §5).
export async function processPendingSaves(deps = {}) {
  const d = defaultDeps(deps);
  const pending = await getPendingUrls();
  let saved = 0;
  for (const entry of pending) {
    try {
      await saveArticle({ url: entry.url, savedVia: 'share' }, d);
      saved += 1;
    } catch (err) {
      console.error('[library] pending save failed:', err.message);
    }
    await removePendingUrl(entry.url);
  }
  return saved;
}
```

- [ ] **Step 4: Run** `npx vitest run src/lib/library.test.js` — Expected: PASS (14 tests).
- [ ] **Step 5: Commit** — `git add src/lib/library.js src/lib/library.test.js && git commit -m "feat: unified save pipeline — paced extraction, shells, tombstone delete"`

---

### Task 5: Rewire `FavoriteToggle` through the library

**Files:**
- Modify: `src/components/FavoriteToggle.jsx`
- Modify: `src/lib/sync.js` (delete the Task-3 interim `pushFavorite`/`removeFavoriteRemote` wrappers)

**Interfaces:**
- Consumes: `saveArticle`, `deleteSaved` (Task 4).
- Produces: hearting stores the body (preloaded when available); un-hearting tombstones. Component API unchanged (`<FavoriteToggle article={...} />`).

- [ ] **Step 1: Rewrite the toggle handler.** Replace `src/components/FavoriteToggle.jsx`'s imports and `toggle`:

```jsx
import { useState, useEffect } from 'react';
import { isFavorited } from '../lib/db';
import { saveArticle, deleteSaved } from '../lib/library';

export default function FavoriteToggle({ article }) {
  const [favorited, setFavorited] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (article?.id) {
      isFavorited(article.id).then(setFavorited);
    }
  }, [article?.id]);

  const toggle = async () => {
    if (!article || saving) return;
    setSaving(true);
    try {
      if (favorited) {
        await deleteSaved({ id: article.id, url: article.url });
        setFavorited(false);
      } else {
        await saveArticle({
          url: article.url,
          id: article.id,
          sourceMeta: article,
          savedVia: 'feed',
          preloadedArticle: article.content || article.textContent ? article : null,
        });
        setFavorited(true);
      }
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
    setSaving(false);
  };
```

(The SVG button markup below `toggle` stays byte-identical; `useAuthStore` import is removed — the library resolves the user itself.)

- [ ] **Step 2: Delete the interim wrappers** — remove `pushFavorite` and `removeFavoriteRemote` from `src/lib/sync.js` (FavoriteToggle was their last importer; verify with `grep -rn "pushFavorite\|removeFavoriteRemote" src` → no hits).
- [ ] **Step 3: Run** `npx vitest run src` and `npm run build` — Expected: both exit 0 (no component test exists; the build proves the import graph).
- [ ] **Step 4: Commit** — `git add src/components/FavoriteToggle.jsx src/lib/sync.js && git commit -m "feat: hearting stores the article body via the library pipeline"`

---

### Task 6: Reader shell handling — `src/pages/ReaderPage.jsx`

**Files:**
- Modify: `src/pages/ReaderPage.jsx` (the `fromFavorites` effect, lines 51–65, and the no-content fallback block)

**Interfaces:**
- Consumes: `resolveReaderSource`, `attachBodyToSaved` (Task 4).
- Produces: every shell (pending, failed, cloud-pulled, migrated) live-fetches on open and files the fetched body; only a URL-less shell shows the terminal card. `resolveReaderSource` is already unit-tested in Task 4 — this task is the wiring.

- [ ] **Step 1: Rewrite the saved-item effect.** Replace the first `useEffect` body in `ReaderPage.jsx`:

```jsx
  useEffect(() => {
    if (fromFavorites && id) {
      // Saved item: branch on CONTENT-presence, not record-presence — a shell
      // (pending/failed/cloud-pulled) must fall back to live extraction.
      getFavorite(id).then((saved) => {
        const effectiveUrl = saved?.url || url;
        const mode = resolveReaderSource(saved, effectiveUrl);
        if (mode === 'stored') {
          setArticle(saved);
        } else if (mode === 'live') {
          fetchArticle(effectiveUrl, sourceId ?? saved?.sourceId);
        } else if (mode === 'shell') {
          setArticle(saved); // URL-less shell — terminal card below
        } else if (url) {
          fetchArticle(url, sourceId);
        }
      });
    } else if (url) {
      fetchArticle(url, sourceId);
    }
    return () => clearArticle();
  }, [url, id]);

  // A live-fetched body for a saved shell gets attached so the item is
  // offline-readable from then on.
  useEffect(() => {
    if (fromFavorites && id && article?.content && article.extractedAt) {
      attachBodyToSaved(id, article).catch(() => {});
    }
  }, [article, fromFavorites, id]);
```

With imports added: `import { resolveReaderSource, attachBodyToSaved } from '../lib/library';`. (`article.extractedAt` exists only on live-extracted articles — `lib/extractor.js` stamps it — so stored bodies don't re-attach in a loop.)

- [ ] **Step 2: Soften the terminal card.** In the no-content else-branch (currently "Could not extract article content."), render the external link only when a `url` exists:

```jsx
          ) : (
            <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
              <p className="font-ui text-sm">Could not extract article content.</p>
              {(article.url || url) && (
                <a
                  href={article.url || url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-3 px-4 py-2 rounded-lg font-ui text-sm"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  Read on original site
                </a>
              )}
            </div>
          )}
```

- [ ] **Step 3: Run** `npx vitest run src && npm run build` — Expected: both exit 0.
- [ ] **Step 4: Commit** — `git add src/pages/ReaderPage.jsx && git commit -m "feat: reader falls back to live extraction for body-less saved items"`

---

### Task 7: Saved page re-compose — rename, paste bar, shell states, cloud delete

**Files:**
- Rename: `src/pages/FavoritesPage.jsx` → `src/pages/SavedPage.jsx` (route path `/favorites` unchanged)
- Create: `src/components/PasteSaveBar.jsx`
- Modify: `src/components/SavedArticleCard.jsx` (badge + shell states, `onRetry`)
- Modify: `src/components/BottomTabBar.jsx` (label `Favorites` → `Saved`)
- Modify: `src/App.jsx` (import rename only in this task)

**Interfaces:**
- Consumes: `saveArticle`, `retrySave`, `deleteSaved`, `firstHttpUrl`, `LibrarySaveError` (Task 4).
- Produces: unified Saved surface. `SavedArticleCard` props become `{ article, onRemove, onRetry }`.

- [ ] **Step 1: Create `src/components/PasteSaveBar.jsx`:**

```jsx
import { useState } from 'react';
import Surface from './ui/Surface';
import Icon from './ui/Icon';
import { saveArticle, firstHttpUrl, LibrarySaveError } from '../lib/library';

export default function PasteSaveBar({ onSaved }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const url = firstHttpUrl(value);
    if (!url) {
      setError('No link found — paste a full article URL.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveArticle({ url, savedVia: 'url' });
      setValue('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof LibrarySaveError ? err.message : 'Could not save that link.');
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="px-4 py-2" style={{ backgroundColor: 'var(--bg-surface)' }}>
      <Surface className="flex items-center gap-2 px-3 py-2">
        <Icon name="plus" size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          type="text"
          inputMode="url"
          placeholder="Paste a link to save it…"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          className="flex-1 bg-transparent outline-none font-ui text-sm"
          style={{ color: 'var(--text-primary)' }}
          aria-label="Paste a link to save"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="font-ui text-sm px-2 py-1 rounded"
          style={{ color: 'var(--accent)', opacity: busy || !value.trim() ? 0.5 : 1 }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </Surface>
      {error && (
        <p className="font-ui text-xs mt-1.5 px-1" style={{ color: 'var(--danger, #B3261E)' }}>{error}</p>
      )}
    </form>
  );
}
```

(If `Icon` has no `plus` glyph, use `name="add"` or the closest existing glyph — check `src/components/ui/Icon.jsx` at implementation time and use a name that exists; do NOT add a new icon system.)

- [ ] **Step 2: Rename + rework the page.** `git mv src/pages/FavoritesPage.jsx src/pages/SavedPage.jsx`, rename the component `SavedPage`, then: heading text `Favorites` → `Saved`; subtitle stays count-based; insert `<PasteSaveBar onSaved={loadFavorites} />` directly under the heading block (ABOVE the search bar); replace `handleRemove`:

```jsx
  const handleRemove = async (id) => {
    const item = favorites.find((a) => a.id === id);
    await deleteSaved({ id, url: item?.url });
    setFavorites((prev) => prev.filter((a) => a.id !== id));
  };

  const handleRetry = async (id) => {
    await retrySave(id);
    loadFavorites();
  };
```

with imports `import { deleteSaved, retrySave } from '../lib/library';` and `import PasteSaveBar from '../components/PasteSaveBar';` (the `removeFavorite` db import goes away). Pass `onRetry={handleRetry}` to `SavedArticleCard`. Update the empty state: `title="Nothing saved yet"`, `message="Paste a link above, share a page to Masthead, or tap the heart on any article."` — and IMPORTANT: the empty state must render BELOW `<PasteSaveBar />`, not instead of the whole page (move the early `favorites.length === 0` return into the list area so the paste bar is always present).

- [ ] **Step 3: Shell states in `src/components/SavedArticleCard.jsx`.** Replace the hardcoded `Saved offline` chip block with:

```jsx
          {article.content ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              Saved offline
            </span>
          ) : article.pendingBody ? (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-tertiary)' }}>
              Fetching…
            </span>
          ) : article.bodyFailed ? (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); onRetry?.(article.id); }}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--danger, #B3261E)' }}
            >
              Couldn't fetch — retry
            </button>
          ) : null}
```

and add `onRetry` to the component's props destructuring. Guard the reading-time row (`article.readingTimeMinutes &&` already does). Update the remove button's `aria-label` to `"Remove from saved"`.

- [ ] **Step 4: Label + imports.** `src/components/BottomTabBar.jsx`: `label: 'Favorites'` → `label: 'Saved'` (path stays `/favorites`). `src/App.jsx`: `import SavedPage from './pages/SavedPage';` and `<Route path="/favorites" element={<SavedPage />} />`.
- [ ] **Step 5: Run** `npx vitest run src && npm run build` — Expected: exit 0 both. Then `npx eslint src/pages/SavedPage.jsx src/components/PasteSaveBar.jsx src/components/SavedArticleCard.jsx` — Expected: exit 0 (0 problems; the 3 baseline errors live in other files).
- [ ] **Step 6: Commit** — `git add -A src/pages src/components/PasteSaveBar.jsx src/components/SavedArticleCard.jsx src/components/BottomTabBar.jsx src/App.jsx && git commit -m "feat: unified Saved page — paste bar, shell states, cloud-consistent delete"`

---

### Task 8: Share target — manifest, `/save` route, gate survival

**Files:**
- Create: `src/pages/SavePage.jsx`
- Modify: `src/App.jsx` (gate allow-list + route + pending-drain effect)
- Modify: `vite.config.js` (manifest `share_target`)

**Interfaces:**
- Consumes: `firstHttpUrl`, `processPendingSaves` (Task 4); `addPendingUrl` (`../lib/db`).
- Produces: OS share sheet → `/save` → stash → Saved page; never drops a share in any app state (spec §5 / review MEDIUM).

- [ ] **Step 1: Create `src/pages/SavePage.jsx`:**

```jsx
import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { addPendingUrl } from '../lib/db';
import { firstHttpUrl } from '../lib/library';

// Web Share Target receiver (spec §5). Stashes the shared URL into the
// existing `pending` IndexedDB store, then hands off to the Saved page —
// App's pending-drain effect performs the actual save once the app is ready.
export default function SavePage() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const shared =
      firstHttpUrl(params.get('url')) ||
      firstHttpUrl(params.get('text')) ||
      firstHttpUrl(params.get('title'));
    (async () => {
      if (shared) await addPendingUrl(shared);
      navigate('/favorites', {
        replace: true,
        state: shared ? { sharedSave: true } : { saveError: 'No link found in the shared content.' },
      });
    })();
  }, []);

  return (
    <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <p className="font-ui text-sm" style={{ color: 'var(--text-tertiary)' }}>Saving…</p>
    </div>
  );
}
```

- [ ] **Step 2: Gate allow-list + pending drain in `src/App.jsx`.** Add `import SavePage from './pages/SavePage';` and `import { processPendingSaves } from './lib/library';`. Replace the onboarding gate and add the drain effect:

```jsx
  const isShareTarget = window.location.pathname === '/save';

  // Drain share-target URLs stashed while the app was gated (spec §5).
  useEffect(() => {
    if (isAuthInitialized && (onboarded || user)) {
      processPendingSaves().catch(() => {});
    }
  }, [isAuthInitialized, onboarded, user]);
```

(place the effect with the other hooks, BEFORE any conditional return — hooks must run unconditionally), then:

```jsx
  // Show onboarding for first-time visitors who aren't signed in — but never
  // swallow a share-target navigation: /save stashes first (review MEDIUM).
  if (!onboarded && !user && !isShareTarget) {
    return <OnboardingPage />;
  }
```

and add the route: `<Route path="/save" element={<SavePage />} />`. Note: when a gated user hits `/save`, SavePage stashes then navigates to `/favorites`, at which point `isShareTarget` is false and the gate correctly shows onboarding — the share survives in `pending` and drains after onboarding via the effect.

- [ ] **Step 3: Manifest.** In `vite.config.js`, inside the `manifest: { ... }` object after `start_url: '/'`, add:

```js
        share_target: {
          action: '/save',
          method: 'GET',
          params: { url: 'url', text: 'text', title: 'title' },
        },
```

- [ ] **Step 4: SavedPage share feedback.** In `src/pages/SavedPage.jsx`, read `location.state` (add `useLocation`) and when `state?.sharedSave` re-run `loadFavorites()` after a short delay so the drained item appears; when `state?.saveError`, surface it via the PasteSaveBar error line or a one-line notice above the list:

```jsx
  const location = useLocation();
  useEffect(() => {
    if (location.state?.sharedSave) {
      const t = setTimeout(loadFavorites, 1500);
      return () => clearTimeout(t);
    }
  }, [location.state, loadFavorites]);
```

and render `{location.state?.saveError && <p className="font-ui text-xs px-4 py-2" style={{ color: 'var(--danger, #B3261E)' }}>{location.state.saveError}</p>}` under the paste bar.

- [ ] **Step 5: Verify manifest output.** Run: `npm run build` (exit 0), then `node -e "const m=require('fs').readFileSync('dist/manifest.webmanifest','utf8');const j=JSON.parse(m);if(j.share_target?.action!== '/save')process.exit(1);console.log('share_target ok')"` — Expected: `share_target ok`.
- [ ] **Step 6: Run** `npx vitest run` — Expected: full suite green.
- [ ] **Step 7: Commit** — `git add src/pages/SavePage.jsx src/pages/SavedPage.jsx src/App.jsx vite.config.js && git commit -m "feat: PWA share target — /save route with gate-surviving pending stash"`

---

### Task 9: Full gates + visual verification

**Files:** none (verification only).

- [ ] **Step 1:** `npm test` bare — Expected: exit 0, all tests green (121 baseline + ~30 new). Cite counts + exit code.
- [ ] **Step 2:** `npm run build` bare — Expected: exit 0 (includes the bundle leak guard) AND the Step-5 manifest check from Task 8 still passes.
- [ ] **Step 3:** `npx eslint src lib api server.js scripts` bare — Expected: exit 1 with EXACTLY the 3 baseline `set-state-in-effect` errors; zero new findings in 2C files.
- [ ] **Step 4: Visual verify (house rule: UI changes need a real surface).** Run `npm run dev` in the background, then use the `/visual-verify` flow (or Playwright CLI directly) to screenshot at 320 and 768 px: (a) the Saved page empty state with paste bar, (b) the Saved page with one saved item (paste a real URL in the flow, e.g. a BBC article — dev server proxies `/api/extract` to `server.js`), (c) the reader opened from Saved, (d) a `bodyFailed` shell row (temporarily disconnect network or paste an unreachable-but-valid URL such as `https://masthead-invalid.example/x`). Both themes for (a) and (b). Inspect the screenshots — spacing, both themes intentional, no overflow at 320.
- [ ] **Step 5:** `git status --short` — clean; all commits present.

---

### Task 10: Pre-flight authorization + rollout (OWNER GATE — one enumerated approval)

**STOP. Present this list verbatim for one approval before executing any of it** (CLAUDE.md pre-flight rule; the harness classifier blocks agent-run prod DDL, so the two migration applies are owner-run `!` commands):

1. **Migration 1 (owner runs):** `! supabase db query --linked -f supabase/migrations/20260719_create_user_saved_articles.sql` — creates `user_saved_articles` (RLS owner-only) and copies any `user_favorites` rows (count + skipped-count reported). `user_favorites` stays up.
2. **Verify RLS live (agent):** advisors clean for the new table; probe matrix via two ephemeral test users created with the service-role admin API (`auth.admin.createUser` + password-grant JWTs): user A INSERT own → 201; A SELECT B's rows → 0 rows; A UPDATE/DELETE B's row → 0 rows affected; A UPDATE own row attempting `user_id` reassignment → rejected by WITH CHECK; anon SELECT/INSERT → permission denied. Delete both test users after.
3. **Merge the 2C PR** (after checks green + security review) → production deploy.
4. **Verify live (agent):** paste-save on masthead-news.vercel.app files an item with body; share-target manifest served; Saved page + reader intact both themes; existing feed/store untouched (`served: "store"` still).
5. **Migration 2 (owner runs, ONLY after step 4 passes):** `! supabase db query --linked -f supabase/migrations/20260719_drop_user_favorites.sql`.
6. Memory + session save.

---

### Task 11: Security review (Opus) + ship

- [ ] **Step 1:** Before the PR: dispatch the fresh-context **Opus** security review (house routing) over: migration 1 (RLS/policies/copy), `src/lib/sync.js` (three-pass merge, tombstones, metadata-only shells), `src/lib/library.js` (pipeline, queue), `src/pages/SavePage.jsx` + App gate change, and the client's cloud-write surface. Adversarial verify each finding; fix CRITICAL/HIGH before the PR.
- [ ] **Step 2:** Push `phase2-2c`, open the PR (guards-not-holes prose), `gh pr checks --watch`, then STOP for the Task 10 enumerated approval (merge is item 3 inside it).

---

## Self-Review Notes (writing-plans checklist)

- **Spec coverage:** §3 schema/RLS/copy → Task 1; discriminator + identity rules → Tasks 4 (saveArticle) + Global Constraints; §4 pipeline incl. metadata-only shells, pacing, 429 backoff, preloaded-body reuse → Task 4; reader content-presence + attach-on-fetch → Task 6 (+ `resolveReaderSource` tested in Task 4); §5 paste + share target + gate survival → Tasks 7, 8; §6 Saved page + delete-with-tombstone + shell states → Task 7; §7 three-pass sync → Task 3; §8 security verification → Tasks 10, 11; §9 two-step rollout → Tasks 1, 10; §10 DoD → Tasks 2–9 tests + Task 10 live probes. All 14 §12 findings have a named home (Global Constraints + task notes).
- **Placeholder scan:** one deliberate implementation-time check (Icon glyph name in Task 7 Step 1) — bounded and explicit, not a TBD.
- **Type consistency:** `saveArticle({url,id,sourceMeta,savedVia,preloadedArticle}, deps)`, `deleteSaved({id,url})`, `removeSaved(userId,{id,url})`, `pushSaved(userId,record)`, `patchSavedArticle(id,patch)` used identically across Tasks 3–8; `resolveReaderSource` return strings match Task 6's branches; row mapper field names match Task 1's columns.
- **Known judgment calls:** route path stays `/favorites` (PWA bookmarks stability) while the page/component is renamed `SavedPage`; `readingTimeMinutes`/`textContent` kept device-local only (not cloud columns — matches spec §3; cloud-pulled items recompute nothing and render fine without them).
