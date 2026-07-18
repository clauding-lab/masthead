# Masthead Phase 2 — Slice 2C: Read-it-later — Design Spec

**Date:** 2026-07-18 (BDT)
**Status:** Design approved by owner 2026-07-18 (five scoping decisions locked in-session); **hardened after a 3-lens adversarial spec review** (14 confirmed findings folded in — see §12). Pending owner review of this document, then `writing-plans`.
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
  deleted_at   timestamptz,               -- soft-delete tombstone (§7): null = live
  primary key (user_id, article_id),
  constraint content_size check (content is null or length(content) <= 1600000)
);
create index user_saved_articles_user_saved_idx
  on public.user_saved_articles (user_id, saved_at desc);
```

The client stamps `updated_at` explicitly on every upsert (no DB trigger); it is the reconciliation key in §7.

**Access model — the 2B recipe, per-user variant.** As with `articles`, the explicit revoke + grant below is the privilege baseline, correct under both Supabase default-privilege regimes:

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

**`user_favorites` is retired across TWO migrations** (review finding: dropping it while the currently-deployed app still queries it silently breaks favorite-sync until the deploy lands). **Migration 1 (before deploy):** create `user_saved_articles` + copy `user_favorites` rows in as metadata shells (`content` null), **filtered to `url ~* '^https?://'`** so a legacy invalid-url row cannot abort the transaction (skipped-row count reported at apply time; total was 0 at the 2026-07-11 mapping). **Migration 2 (after the new app is deploy-verified):** `drop table public.user_favorites`. `user_history` is untouched.

**Identity/dedup (review finding: url alone regresses link-less items):** `article_id` is the **caller-supplied headline id when one exists** (the feed's `articleId(item)` with its link→guid→title fallback) and `articleId(url)` only for paste/share, where no id exists. Save is rejected only when both are absent. A hearted item and a pasted URL for the same linked article still collide to one PK (both hash the same canonicalized URL); link-less feed items keep their guid/title identity and remain heartable.

**Local discriminator (review finding):** the Saved list's inclusion rule is the existing `isFavorite === true` flag on the IndexedDB `articles` store — `saveArticle` sets it on **every** save regardless of channel (plus cosmetic `savedVia: 'feed' | 'url' | 'share'`), so pasted/shared items appear in the list the existing `getAllFavorites()` query serves.

---

## 4. Save pipeline (client-orchestrated)

One function, all channels: `saveArticle({ url, id?, sourceMeta? })` in a new `src/lib/library.js`.

1. **Identity:** use the caller-supplied `id` (heart flow passes `headline.id`) or derive `articleId(url)` for paste/share. Both absent/null → reject with a friendly error.
2. **File intent immediately:** write a metadata record to IndexedDB (`articles` store, keyPath `id`) with `isFavorite: true`, `savedVia`, `pendingBody: true` — title placeholder if unknown. UI shows the item instantly.
3. **Extract:** call the existing `POST /api/extract` (SSRF-guarded, rate-limited, sanitized server-side — no new extraction surface). On success, attach `content`, `byline`, `excerpt`, `leadImage`, `wordCount`; clear `pendingBody`. Client caps `content` at 1.5 MB (truncate + `contentTruncated: true`). **Exception (review finding):** hearting from the READER reuses the already-loaded `article.content` instead of re-extracting — the app already holds the body.
4. **Cloud (signed-in only):** upsert to `user_saved_articles` via supabase-js under the user's session (`onConflict: 'user_id,article_id'`), client-stamped `updated_at`, `deleted_at: null` (re-saving a deleted item revives it). RLS enforces ownership; no new secrets.
5. **Failure:** extraction error → the record stays a metadata shell (`pendingBody: false, bodyFailed: true`) with "couldn't fetch — tap to retry" in BOTH the Saved list and the reader (§6). **The cloud upsert for a shell is metadata-only — it never includes the `content` columns — so a failed re-save can never null a body already stored in the cloud** (review finding: the naive full-row shell upsert was destructive on a routine path). On 429, the queue backs off and retries (honoring `Retry-After` when present) before marking `bodyFailed`.

**Heart flow (D4):** hearting = `saveArticle({ url, id: headline.id, sourceMeta })` — metadata files instantly (UI unblocked), body attaches in the background. Un-hearting = delete (§6 semantics, local + cloud tombstone). The client-side extraction queue is sequential **and paced (≥3s spacing)**; under `/api/extract`'s 20/60s limit the guarantee is honest degradation — backoff, then shell + retry — not immunity (review finding: concurrency-1 alone does not bound rate).

**Reader integration (explicit ReaderPage change — review finding: the assumed fallback does not exist today):** the reader's saved-item branch keys on **content-presence, not record-presence**: `saved && saved.content` → render stored body; `saved && !saved.content` (shell: pending, failed, or cloud-pulled — including every migrated pre-2C favorite) → fall back to live `fetchArticle(url, sourceId)` exactly like an unsaved article, and attach the result to the record on success. A shell with no usable `url` renders the retry affordance instead of a dead-end.

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

**Gate survival (review finding: today's `App.jsx` renders OnboardingPage before the router mounts, which would silently discard a share):** `/save` is allow-listed ahead of the onboarding/auth gate — the route stashes the shared URL into the existing `pending` IndexedDB store, then lets the normal gate flow proceed; the pending queue is processed (via the same `saveArticle` pipeline, with visible feedback) once the app reaches its ready state. A share is never dropped, whatever state the PWA wakes in.

---

## 6. Saved page (re-compose of FavoritesPage)

Quiet Editorial re-composition (2A tokens/primitives; this is the slice 2A reserved it for): paste input on top; one newest-first list; each row = title, source tag, saved-date, thumbnail when present, an **offline badge** only when a body is actually stored, and the shell/retry state for failed extractions. **Delete removes the item locally AND (signed-in) tombstones the cloud row via `removeSaved` — identical semantics to un-hearting** (review finding: the existing FavoritesPage delete is local-only, so deleted items would resurrect from cloud on the next sync). Empty state invites pasting a first link. No read/archive states, tags, or search (deferred — queue semantics explicitly out). `src/lib/db.js` keeps the `articles` store (no IndexedDB version bump needed — new fields are additive on existing keyPath).

---

## 7. Sync — `src/lib/sync.js` rework

Three passes, not the old two (review finding: the inherited set-difference merge can never reconcile an id present on both sides, and supabase-js upsert is an unconditional overwrite — "last-save-wins" needs an explicit reconciler):

1. **Deletes first:** cloud rows with `deleted_at` set are authoritative tombstones — remove any local copy; never re-push a tombstoned id (review finding: tombstone-less sync resurrects deliberate deletes via stale peers). Re-saving later revives the row (`deleted_at: null`, §4 step 4).
2. **Set difference:** push local records absent in cloud (bodies included); pull live cloud records absent locally.
3. **Reconcile the intersection:** for ids present on both sides — **a body always beats a shell, regardless of timestamps**; two bodies (or two shells) → newer client-stamped `updated_at` wins, copied in the winning direction. This is what upgrades a failed-extraction shell on device A with the full body device B captured.

`pushSaved`/`removeSaved` replace `pushFavorite`/`removeFavoriteRemote` against the new table; `removeSaved` is an update setting `deleted_at` (tombstone), not a row delete. History sync unchanged. Sign-out behavior unchanged (existing local-data clearing rules apply).

---

## 8. Security

- **RLS:** the §3 recipe; verified like 2B — advisors clean for the new table, plus **live cross-user probes**: user A cannot SELECT/UPDATE/DELETE user B's rows; anon gets nothing (401/permission denied); an UPDATE attempting to change `user_id` is rejected by `with check`.
- **No new server write path, no new secrets, no service-role expansion, no CSP change.** The only server code touched is none; `/api/extract`'s existing guards (SSRF, rate limit, sanitize) carry the slice.
- **Stored bodies are sanitized twice:** server-side at extraction (`sanitizeServer.js`) and client-side at render (`sanitize.js`) — the existing defense-in-depth, now also covering cloud-roundtripped bodies.
- **Privacy:** a user's library reveals reading interests — RLS owner-only is the product requirement, not just hygiene. Nothing about saved items is ever written to public tables.
- Migration + RLS apply is an AGENTS out-of-scope item → one pre-flight authorization at implementation time (2B pattern; note the harness classifier blocks agent-run prod DDL — owner runs the one apply command via `!`).

---

## 9. Rollout

1. **Migration 1** (create `user_saved_articles` + grants/policies + filtered copy from `user_favorites`; the old table stays up) — pre-flight gated.
2. Deploy app (client-only changes + manifest). The still-deployed old app keeps syncing to the still-present `user_favorites` until this completes — zero outage window (review finding).
3. Verify live (§10).
4. **Migration 2** (`drop table public.user_favorites`) — only after step 3 passes. No flag day; no env-var changes.

---

## 10. Testing & verification (definition of done)

- **Pipeline unit tests:** save-by-URL happy path; extraction-failure → shell with `bodyFailed`; retry attaches body; dedup (heart then paste same URL → one record); **link-less feed item hearts under its headline id**; every channel sets the `isFavorite` discriminator (pasted item appears in the list query); non-http(s)/garbage URL rejected; 1.5 MB truncation sets flag; queue pacing + 429 backoff; **a shell upsert against a cloud row with a body leaves the body intact**; heart-from-reader reuses the loaded body (no extract call).
- **Reader tests:** shell (content-null) record → live-extraction fallback fires; stored body renders without a fetch; migrated metadata-only favorite opens readable.
- **Share route tests:** `/save?url=…` saves; URL-in-`text` fallback parses; no-URL redirects with error; **share while signed-out/not-onboarded stashes to `pending` and processes on ready**.
- **Sync tests (mocked supabase):** three-pass merge matrix — tombstone removes local + blocks re-push; body-beats-shell both directions; newer-`updated_at` wins between two bodies; delete from Saved page tombstones cloud; re-save revives; sign-out unchanged; `user_history` paths untouched.
- **Migration test (SQL review):** copy step filters non-http(s) urls and reports skipped count; migration 2 is a separate file.
- **Live security probes (deploy-verify):** cross-user + anon rejection matrix on `user_saved_articles`; `user_id`-reassignment UPDATE rejected; advisors clean.
- **Regression:** full suite green (current 121 + new); `npm run build` (includes bundle guard) exit 0; lint = 3-error baseline; both themes; PWA installability with the new manifest key.
- **Opus security review** of the migration, sync rework, and save pipeline before merge; deploy-verified live.

---

## 11. Explicitly out of scope

Bookmarklet; Siri Shortcut / `api/save-url` persistence (endpoint stays as-is); read/archive/queue states; tags, search, full-text search; body storage for history; sharing/exporting libraries; per-user feed polling (2E); any change to `api/*` endpoints.

---

## 12. Review hardening log

**2026-07-18 — 3-lens adversarial spec review** (data/sync · security/RLS/privacy · product failure-modes), fresh-context Opus attackers, every finding challenged by a fresh-context skeptic before counting: **14 confirmed** (consolidated below), **6 refuted**. All confirmed findings are folded into this revision:

- **HIGH · reader shell dead-end** (found by two lenses independently): the assumed "reader falls back for shells" path did not exist — today's ReaderPage falls back only on record-ABSENCE, so every pending/failed/cloud-pulled/migrated shell rendered a dead-end. Fixed: content-presence branch specced as an explicit ReaderPage change (§4).
- **HIGH · unimplementable sync promise:** set-difference merge never touches same-id rows, and supabase-js upsert is an unconditional overwrite, so "last-save-wins by updated_at" could never run — shell↔body copies on two devices would never reconcile. Fixed: explicit three-pass sync with an intersection reconciler, client-stamped `updated_at`, body-beats-shell rule (§7).
- **HIGH · shell nulls a stored body:** a failed re-save's full-row upsert would overwrite an existing cloud body with `content: null` — silent data loss on a routine path. Fixed: shell upserts are metadata-only (§4 step 5).
- **HIGH · Saved-page delete resurrects:** the existing delete affordance is local-only; the cloud row would return on next sync. Fixed: delete = local + cloud tombstone, identical to un-heart (§6), plus soft-delete `deleted_at` tombstones so stale peers can't resurrect deliberate deletes (§3, §7).
- **MEDIUM · link-less feed items unheartable** under `articleId(url)`-only identity → caller-supplied headline id preferred (§3, §4 step 1).
- **MEDIUM · pasted items invisible** to the `isFavorite`-filtered list query → discriminator set on every save, named in the spec (§3, §4 step 2).
- **MEDIUM · migration drop window** breaking live favorite-sync + legacy-row url CHECK aborting the copy → two migrations, filtered copy (§3, §9).
- **MEDIUM · share dropped at the onboarding/auth gate** → `/save` allow-listed, stash-to-pending, process-on-ready (§5).
- **LOW · false rate-limit guarantee** (concurrency ≠ rate; shared bucket with reader opens; reader-heart re-extracting a body already in hand) → paced queue, 429 backoff, honest wording, reader-heart reuses loaded body (§4).
- **LOW · public-repo prose** narrating the pre-guard privilege state → neutralized to the 2B baseline wording (§3).

Refuted (checked, not real): sync payload-size blowup (browser→PostgREST direct, not through Vercel limits); `/save` CSRF framing (visible, top-level-navigation-only, self-scoped writes); "sanitized twice is false" (both layers verified present); spoofable X-Forwarded-For rate key (Vercel appends the real peer IP); service-role grant on the new table (baseline pattern, no server path); missing `published_at` parity (pre-existing cosmetic, not a 2C regression).
