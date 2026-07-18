# Masthead Phase 2 — Slice 2C: Read-it-later — Design Spec

**Date:** 2026-07-18 (BDT)
**Status:** Design approved by owner 2026-07-18 (five scoping decisions locked in-session). Pending adversarial spec review + owner review of this document, then `writing-plans`.
**Owner:** Adnan (product) / AI agents (implementation)
**Parent:** `docs/superpowers/specs/2026-07-11-phase2-reader-design.md` (§4.2 stubs this slice) → `docs/superpowers/specs/2026-07-11-public-masthead-design.md`.
**Depends on:** 2B (shipped 2026-07-18 — the store, shared `lib/articleId.js`, RLS discipline). **Unblocks:** nothing hard; 2D/2E proceed independently.

---

## 1. Goal

Give Masthead a **library**. Today a reader can heart a feed headline (metadata saved; the body is kept only if they happened to open it) and nothing else: no saving an arbitrary link, no share-sheet entry, and `api/save-url` extracts a page then throws the result away. 2C ships one unified **Saved** surface where every saved item — hearted headline or pasted/shared URL — has its **full article body fetched at save time** and filed: readable forever, offline, even if the publisher page later dies.

### Success criteria

- Paste any public article URL → it appears in Saved with its extracted body, logged-out (device-only) AND signed-in (cloud row, visible from a second device).
- Share a page to Masthead from the OS share sheet (Android / installed desktop PWA) → same result.
- Hearting a headline stores its body in the background without blocking the UI.
- A signed-in user's library is **provably private**: cross-user reads/writes and anon access rejected live.
- Extraction failure never loses intent: the item files as a metadata shell with visible retry.
- Zero regression: feed, reader, history, auth, PWA, both themes; existing test suite stays green.
- Deploy-verified live on `masthead-news.vercel.app`.

---

## 2. Decisions (locked with owner 2026-07-18)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | **Body storage** | Cloud (`user_saved_articles`, RLS owner-only) when signed in; device IndexedDB always. Local-first: the device copy is written before, and regardless of, the cloud copy. | Library follows the user across devices; logged-out readers lose nothing. Matches the app's works-logged-out / better-logged-in pattern. |
| D2 | **Channels** | Paste-a-URL + PWA **Web Share Target** only. **Bookmarklet and Siri Shortcut are OUT.** | Owner cut them 2026-07-18. Removes the slice's riskiest surface (third-party-page capture, CORS-open endpoint, per-user tokens). All bodies now come from our own guarded extractor on public URLs. |
| D3 | **IA** | One unified **Saved** page (FavoritesPage re-composed, Quiet Editorial). Hearts and saved URLs are one list, newest-first. | One mental model, one code path. 2A deliberately left this page for 2C. |
| D4 | **Body timing** | **Every save stores the body** — hearting triggers one background extraction. | Saved list always fully readable/offline. Consistent with pasted links, which must extract anyway. |
| D5 | **Architecture** | **Client-orchestrated**: app calls the existing `/api/extract`, stores locally, and (signed-in) upserts to the new table under the **user's own JWT**. New table **replaces** `user_favorites`. | No new server write path; no service-role expansion; reuses 2B-hardened guards. `user_favorites` had 0 rows at 2B mapping; replacing beats extending. |

---

## 3. Data model — `public.user_saved_articles`

```sql
create table public.user_saved_articles (
  user_id      uuid not null references auth.users (id) on delete cascade,
  article_id   text not null,            -- shared articleId(url); dedups with feed items
  url          text not null check (url ~* '^https?://'),
  title        text,
  byline       text,
  excerpt      text,
  content      text,                     -- sanitized HTML body; null = metadata shell
  content_truncated boolean not null default false,
  lead_image   text,
  word_count   integer,
  source_id    text,
  source_name  text,
  source_color text,
  is_paywall   boolean not null default false,
  saved_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, article_id),
  constraint content_size check (content is null or length(content) <= 1600000)
);
create index user_saved_articles_user_saved_idx
  on public.user_saved_articles (user_id, saved_at desc);
```

**Access model — the 2B recipe, per-user variant.** This project is on the OLD Supabase auto-grant regime (verified 2026-07-18: `pg_default_acl` grants api roles full table privileges), so the explicit revoke is load-bearing:

```sql
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
-- anon: no grants, no policies. UPDATE carries BOTH using AND with check so a row
-- can never be reassigned to another user. (select auth.uid()) initplan form, not
-- bare auth.uid() — avoids the per-row re-evaluation the advisors flag.
```

**`user_favorites` is retired in the same migration:** copy any rows into `user_saved_articles` as metadata shells (`content` null), `on conflict do nothing`, then `drop table public.user_favorites`. Row count is checked and reported at apply time (was 0 at the 2026-07-11 mapping). `user_history` is untouched.

**Identity/dedup:** `article_id = articleId(url)` from shared `lib/articleId.js` (2B). Pasting a URL you already hearted resolves to the same PK → upsert, one library entry. Feed-vs-pasted provenance is cosmetic, not identity.

---

## 4. Save pipeline (client-orchestrated)

One function, all channels: `saveArticle({ url, sourceMeta? })` in a new `src/lib/library.js`.

1. `articleId(url)` → id (null → reject with a friendly error; non-http(s) rejected).
2. **File intent immediately:** write a metadata record to IndexedDB (`articles` store, keyPath `id`) — title placeholder if unknown, `pendingBody: true`. UI shows the item instantly.
3. **Extract:** call the existing `POST /api/extract` (SSRF-guarded, rate-limited, sanitized server-side — no new extraction surface). On success, attach `content`, `byline`, `excerpt`, `leadImage`, `wordCount` to the local record; clear `pendingBody`. Client caps `content` at 1.5 MB (truncate + `contentTruncated: true`).
4. **Cloud (signed-in only):** upsert the full record to `user_saved_articles` via supabase-js under the user's session (`onConflict: 'user_id,article_id'`). RLS enforces ownership; the client never needs new secrets.
5. **Failure:** extraction error → record stays a metadata shell (`pendingBody: false, bodyFailed: true`); Saved page renders it with "couldn't fetch — tap to retry" (retry re-runs step 3). Cloud shell is still upserted so the intent syncs.

**Heart flow (D4):** hearting a headline = `saveArticle` with the headline's metadata as `sourceMeta` — the metadata files instantly (today's behavior, UI unblocked), body attaches in the background. Un-hearting deletes locally + cloud. A small client-side queue runs extractions **sequentially** (concurrency 1) so a heart-spree cannot trip `/api/extract`'s rate limit.

**Reader integration:** opening a saved item uses the stored body (today's `fromFavorites` path, generalized); if the item is a shell, the reader falls back to live extraction as it does now.

---

## 5. Channels

**Paste-a-URL:** input at the top of the Saved page. Accepts a bare URL or text containing one (first `https?://` match). Validates via `articleId` before calling the pipeline.

**PWA Web Share Target** (`vite.config.js` → VitePWA manifest):

```json
"share_target": {
  "action": "/save",
  "method": "GET",
  "params": { "url": "url", "text": "text", "title": "title" }
}
```

New React route `/save`: reads `url` param, falling back to first URL found in `text` (many Android apps put the link there); no URL found → redirect to Saved with an error toast. Otherwise runs `saveArticle`, redirects to Saved with the new item visible (shell first, body attaching). Supported on Android + installed desktop PWA; iOS has no share-target support — iOS users paste. Route is client-side only; no server change, no CSP change.

---

## 6. Saved page (re-compose of FavoritesPage)

Quiet Editorial re-composition (2A tokens/primitives; this is the slice 2A reserved it for): paste input on top; one newest-first list; each row = title, source tag, saved-date, thumbnail when present, an **offline badge** when a body is stored, and the shell/retry state for failed extractions. Delete via existing affordance. Empty state invites pasting a first link. No read/archive states, tags, or search (deferred — queue semantics explicitly out). `src/lib/db.js` keeps the `articles` store (no IndexedDB version bump needed — new fields are additive on existing keyPath).

---

## 7. Sync — `src/lib/sync.js` rework

- `syncOnSignIn` favorites section is **replaced** by saved-articles sync against `user_saved_articles`: push local records (bodies included) not in cloud, pull cloud records not local. Conflict on same PK: **last-save-wins** by `updated_at` (for identical articles this is a non-event).
- `pushFavorite`/`removeFavoriteRemote` become `pushSaved`/`removeSaved` against the new table (bodies included).
- History sync unchanged.
- Sign-out behavior unchanged (existing local-data clearing rules apply).

---

## 8. Security

- **RLS:** the §3 recipe; verified like 2B — advisors clean for the new table, plus **live cross-user probes**: user A cannot SELECT/UPDATE/DELETE user B's rows; anon gets nothing (401/permission denied); an UPDATE attempting to change `user_id` is rejected by `with check`.
- **No new server write path, no new secrets, no service-role expansion, no CSP change.** The only server code touched is none; `/api/extract`'s existing guards (SSRF, rate limit, sanitize) carry the slice.
- **Stored bodies are sanitized twice:** server-side at extraction (`sanitizeServer.js`) and client-side at render (`sanitize.js`) — the existing defense-in-depth, now also covering cloud-roundtripped bodies.
- **Privacy:** a user's library reveals reading interests — RLS owner-only is the product requirement, not just hygiene. Nothing about saved items is ever written to public tables.
- Migration + RLS apply is an AGENTS out-of-scope item → one pre-flight authorization at implementation time (2B pattern; note the harness classifier blocks agent-run prod DDL — owner runs the one apply command via `!`).

---

## 9. Rollout

1. Migration (new table + grants/policies + `user_favorites` copy-and-drop) — pre-flight gated.
2. Deploy app (client-only changes + manifest). Order-independent of the migration for logged-out users; signed-in sync simply no-ops until the table exists, so land migration first anyway.
3. Verify live (§10). No flag day; no env-var changes.

---

## 10. Testing & verification (definition of done)

- **Pipeline unit tests:** save-by-URL happy path; extraction-failure → shell with `bodyFailed`; retry attaches body; dedup (heart then paste same URL → one record); non-http(s)/garbage URL rejected; 1.5 MB truncation sets flag; sequential queue under a heart-spree.
- **Share route tests:** `/save?url=…` saves; URL-in-`text` fallback parses; no-URL redirects with error.
- **Sync tests (mocked supabase):** push/pull merge, last-save-wins, sign-out unchanged; `user_history` paths untouched.
- **Live security probes (deploy-verify):** cross-user + anon rejection matrix on `user_saved_articles`; `user_id`-reassignment UPDATE rejected; advisors clean.
- **Regression:** full suite green (current 121 + new); `npm run build` (includes bundle guard) exit 0; lint = 3-error baseline; both themes; PWA installability with the new manifest key.
- **Opus security review** of the migration, sync rework, and save pipeline before merge; deploy-verified live.

---

## 11. Explicitly out of scope

Bookmarklet; Siri Shortcut / `api/save-url` persistence (endpoint stays as-is); read/archive/queue states; tags, search, full-text search; body storage for history; sharing/exporting libraries; per-user feed polling (2E); any change to `api/*` endpoints.

---

## 12. Review hardening log

*(to be filled by the pre-gate adversarial review)*
