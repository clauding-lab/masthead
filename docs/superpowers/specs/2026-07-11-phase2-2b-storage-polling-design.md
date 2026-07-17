# Masthead Phase 2 — Slice 2B: Server-side article storage + polling — Design Spec

**Date:** 2026-07-11 (BDT)
**Status:** Design approved by owner 2026-07-11; **hardened after a 3-lens adversarial spec review** (see §12). Ready for implementation plan (`writing-plans`) pending owner re-review of the hardened spec.
**Owner:** Adnan (product) / AI agents (implementation)
**Parent:** `docs/superpowers/specs/2026-07-11-phase2-reader-design.md` (§4.1 stubs this slice) → `docs/superpowers/specs/2026-07-11-public-masthead-design.md` (§4 roadmap).
**Depends on:** 2A (shipped — the UI language). **Unblocks:** 2C (read-it-later), 2D (blogs/catalog), 2E (premium feeds), and Phase 3 (email inbox) — all read from the store this slice builds.

---

## 1. Goal

Give Masthead a memory. Today the app is **fetch-on-demand**: every feed open re-fetches all selected RSS feeds live, server-side, hitting every publisher on every refresh (there is a 5-minute in-memory cache, but the path the client actually uses — `POST /api/feeds` — skips it). 2B introduces a **store-and-serve** model: a scheduled poller writes articles into our own Supabase table, and the feed reads from that store instead of fanning out live.

This is the **load-bearing infrastructure slice**, deliberately scoped to the *headline index only* — not full article bodies — so it ships lean and cheap while establishing the store, the poller, the retention discipline, and the service-role write path that later slices inherit.

### Success criteria

- The catalog feed is served from our own store, refreshed by a cron every ~20 minutes, with an honest **14-day** retention window (no per-source cap silently shortening it).
- The client (`feedStore`, `src/lib/api.js`) is **unchanged** — the read endpoint keeps its exact request/response contract, **and every existing guard on it (rate-limit, CORS, JSON validation, source cap) is preserved**.
- **Zero functional regression:** custom user feeds still work; favourites/history still work (including on devices that already saved articles before 2B — see D4); the app works logged-out; the app never breaks even before the first poll or during a DB outage (throttled live fallback).
- The `articles` table is genuinely write-locked (RLS enabled + explicit grants; anon writes provably rejected) on a PUBLIC repo.
- First real (capped) running cost, bounded and predictable; a load-bearing job that **fails loudly**, not silently.
- Deploy-verified live on `masthead-news.vercel.app`.

---

## 2. Decisions (locked with owner 2026-07-11; refined by the §12 review)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | **Storage scope** | Headlines + metadata only. Full-article bodies stay live-on-open (`/api/extract`). | Extracting ~150 items/run is slow, fragile, storage-heavy, mostly wasted; body storage is 2C (on-save). |
| D2 | **Cadence** | Native **Vercel Cron**, `*/20 * * * *`. Owner is on **Vercel Pro**. | Already paid for; simplest; in-repo + reviewable; exact timing; one fewer moving part than an external trigger. |
| D3 | **Custom sources** | **Hybrid.** Poller polls only the 10 curated catalog feeds. Custom feeds stay live-fetched and merged, decided *inside* `/api/feeds` (client contract untouched). | Preserves an existing feature; poller stays global; avoids per-user polling (cost-scales-with-users + private-write RLS). |
| D4 | **Article identity** | One shared **pure-JS** hash `lib/articleId.js` (`canonicalizeUrl` + `articleId`), used by `feedParser`, `extractor`, the poller, **and the browser**. Canonicalise before hashing; **total** (never throws); preserve the `link → guid → title` fallback so link-less items stay distinct. Widened (64-bit / 16-hex) vs today's 48-bit. **Re-key device-local IndexedDB** favourites/history to the new id via a one-time upgrade. | Structural lockstep (list-id == reader-id, single-sourced). Pure-JS ⇒ server and browser compute the *same* id, which is what makes the IndexedDB re-key possible — closing the pre-2B favourite-orphan gap the first review draft missed. Canonicalisation kills duplicate rows from rotating tracking params. |
| D5 | **Retention** | Prune each run: `first_seen_at < now() − 14 days`. **No low per-source cap** (only a very-high runaway guard, if any, ordered by `first_seen_at`). | Owner chose the tightest window (freshest, ~5–8 MB). A 200/source cap would silently cut busy sources (BBC/TechCrunch) to <2 days — making the "14-day" promise false. `first_seen_at` (not publisher date) guarantees shelf life regardless of unreliable feed dates. |
| D6 | **Access model** | New `articles` table with **RLS explicitly enabled**, explicit `revoke`/`grant`, **public `SELECT`**, and **writes reachable only via `service_role`** (verified by an anon-write-rejected test). New server-only secrets `SUPABASE_SERVICE_ROLE_KEY` + `CRON_SECRET`; new non-`VITE_` `SUPABASE_URL`/`SUPABASE_ANON_KEY` for server reads. Favourites/history RLS unchanged. | Reading is public/login-free by design and must stay so. Least privilege, but *provably* so — not "no write policy" prose (which, without `enable RLS`, leaves the table world-writable: AGENTS landmine #5 / `postgres-revoke-public-gotcha`). |

---

## 3. Architecture

```
  Vercel Cron  (*/20 * * * *, Production only)
        │  Authorization: Bearer $CRON_SECRET   (fail-closed; timingSafeEqual)
        ▼
  api/cron/poll.mjs  (region: bom1)
        │  fetchAllFeeds(catalog)  →  10 catalog RSS feeds via safeFetch
        │  dedupe batch by (source_id, id)  →  service-role upsert  →  prune 14d
        │  503 if succeeded===0 or upsert throws  (fails LOUD in Vercel cron dashboard)
        ▼
  ┌──────────────────┐  RLS ENABLED · public SELECT · service_role writes only
  │  public.articles │  PK (source_id, id)
  └──────────────────┘
        ▲  anon SELECT (bound query builder; selected catalog sources; snake→camel map)
        │
  api/feeds.mjs  [preserve: CORS · rate-limit 60/60s · JSON guard · 30-source cap]
        │  split catalog(store) vs custom(live safeFetch) · merge/sort
        │  cold-vs-empty probe · throttled+cached live fallback
        ▲   unchanged request/response contract
        │
  src/lib/api.js → src/stores/feedStore.js  (UNCHANGED)
```

### 3.1 New / changed files

All shared server logic lives in `lib/` and is imported by both `api/*.mjs` (prod) and `server.js` (dev) — AGENTS landmine #1 (no dev/prod drift). The **read** client and the **admin** client are separate modules so the service-role factory never enters the read path's import graph (§6, Finding 5).

| File | Change | Purpose |
|---|---|---|
| `lib/articleId.js` | **new** | `canonicalizeUrl(url)` + `articleId(linkOrItem)`. Pure-JS, total, node+browser identical. Single source of truth for identity. |
| `lib/articleId.test.js` | **new** | Totality (empty / non-URL / guid-only) + variant stability (scheme, www, trailing slash, param order, tracking params) + distinctness of two link-less items. |
| `lib/supabaseRead.js` | **new** | Anon read client (server-side), from non-`VITE_` `SUPABASE_URL`/`SUPABASE_ANON_KEY`. Safe in any server graph. |
| `lib/supabaseAdmin.js` | **new** | Service-role client. **Top-of-file tripwire:** `if (typeof window !== 'undefined') throw`. Reads `SUPABASE_SERVICE_ROLE_KEY` (never `VITE_`). |
| `lib/articlesRepo.js` | **new** | READ-side repo over `public.articles`: `selectHeadlines({ sourceIds, category, limit })` (uses `supabaseRead`), `storeIsWarm()` (global warmth probe). Bound query-builder only; maps snake_case → camelCase headline shape. |
| `lib/articlesWrite.js` | **new** | WRITE-side (poller only): `upsertArticles(rows)` (dedupes batch by `(source_id,id)` first), `prune({ maxAgeDays })`. Uses `supabaseAdmin`. Kept off the read path's import graph. |
| `lib/*.test.js` (repo/write) | **new** | Batch dedupe (same `(source_id,id)` twice → one row, no throw), select filter + shape parity with `mapFeedItems`, prune cutoff. |
| `api/cron/poll.mjs` | **new** | The poller handler (auth, fetch, dedupe, upsert, prune, fail-loud). |
| `api/feeds.mjs` | **edit** | Store-aware **after** the existing guard chain; split catalog/custom; cold-vs-empty; throttled cached fallback. Contract unchanged. |
| `server.js` | **edit** | Mirror the store-aware `/api/feeds` (same `lib/` imports) so dev matches prod. |
| `lib/feedParser.js` / `lib/extractor.js` | **edit** | Replace local `hashUrl` with shared `articleId` (identity single-sourced). |
| `src/lib/db.js` | **edit** | Bump `DB_VERSION`; one-time upgrade re-keys `articles`/`history` stores by `articleId(record.url)` (both retain `url`) using the same shared `lib/articleId.js`. |
| `supabase/migrations/<ts>_create_articles.sql` | **new** | Table + composite PK + indexes + **`enable RLS` + explicit `revoke`/`grant`** + single SELECT policy. Version-controlled. |
| `vercel.json` | **edit** | Add `crons` + `functions` `maxDuration` **and `regions: ["bom1"]`** for `api/cron/poll.mjs`. **No CSP / security-header change** (§6). |
| `.env.example` | **edit** | Document `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`. |

No new npm dependency: `@supabase/supabase-js` is already installed (`src/` only today); 2B adds a server-side import. `rss-parser`, `sanitize-html`, `safeFetch` reused.

---

## 4. Data model — `public.articles`

Columns mirror today's mapped headline shape (`lib/feedParser.js` `mapFeedItems`).

| Column | Type | Notes |
|---|---|---|
| `source_id` | `text` | catalog slug (e.g. `daily-star`). **Part of PK.** |
| `id` | `text` | `articleId(canonical url)` — **source-independent**, same scheme `user_favorites.article_id` / `user_history.article_id` use. **Part of PK.** |
| `url` | `text` NOT NULL | the real, openable article URL (last-seen). |
| `title` | `text` | |
| `source_name` / `source_short_name` / `source_color` | `text` | denormalised for display. |
| `category` | `text` | **free text**, not an enum. |
| `thumbnail` | `text` | nullable. |
| `is_paywall` | `boolean` default `false` | |
| `published_at` | `timestamptz` | publisher date (sort key). |
| `first_seen_at` | `timestamptz` default `now()` | retention key. |
| `updated_at` | `timestamptz` default `now()` | bumped on upsert. |

**Primary key = `(source_id, id)`.** Identity and attribution are separated (Finding 3): `id` is the source-independent article identity (so favourites/reader-matching work regardless of which source surfaced it), while `source_id` keeps **each source's row distinct**. Consequences:

- **Within a source, across polls:** same `(source_id, id)` → upsert dedups. ✓ (the real dedup goal)
- **Across sources** (e.g. Hacker News links a Verge URL that Verge's own feed also carries): two rows, `(hacker-news, X)` and `(the-verge, X)` — both preserved, correct source tag/colour, and a source-filtered read shows each under its own source. This matches **today's** behaviour (live `fetchAllFeeds` concatenates per-source items with no cross-source dedup) → **zero regression**, and it eliminates the CRITICAL "same-batch duplicate PK" crash for the cross-source case.
- **Favourites/reader matching:** keyed on `id` alone (source-independent) → favouriting the Verge article and opening it via HN's row both resolve to the same heart state. ✓

**Indexes:** `(published_at desc)`, `(source_id, published_at desc)`, `(category, published_at desc)`, `(first_seen_at)` — cover read filters, sort, and prune scan.

**Read-back mapping (Finding "snake→camel"):** `selectHeadlines` returns the **camelCase** headline shape the client renders (`id, url, title, sourceId, sourceName, sourceShortName, sourceColor, category, thumbnail, isPaywall, publishedAt`) — a repo test asserts its keys equal `feedParser.mapFeedItems` output. Raw snake_case rows would render blank source tags / bad timestamps only on store hits.

---

## 5. Components

### 5.1 The poller — `api/cron/poll.mjs` (region `bom1`)

Order (auth replaces the user rate-limiter; the caller is Vercel Cron, Production-only):

1. **Auth, fail-closed & injection-safe:** `if (!process.env.CRON_SECRET) return 401` **before** any compare; then `crypto.timingSafeEqual` of the `Authorization` header against `Bearer <secret>` (length-guarded). Reject the wrong HTTP method (405). **Never log the `Authorization` header or the secret.** (Closes the `"Bearer undefined"` bypass + timing + log-leak findings.)
2. `fetchAllFeeds(sources.sources)` — all 10 catalog sources, no category filter; reused verbatim; returns `{ headlines, stats }` (landmine #8); outbound via `safeFetch` (SSRF).
3. Map to rows; **`upsertArticles(rows)`** — which **dedupes the batch in-memory by `(source_id, id)` (last-write-wins) before the single `.upsert()`** so no statement carries a duplicate PK (closes the CRITICAL upsert-crash).
4. `prune({ maxAgeDays: 14 })` — `delete where first_seen_at < now() − 14 days`.
5. **Fail loud:** respond `503` when `stats.succeeded === 0` **or** the upsert throws (so Vercel's cron dashboard marks the run failed); otherwise `200 { ok, stats, upserted, pruned }`. Per-feed failures alone don't fail the run (isolation in `fetchAllFeeds`). Region pinned **`bom1`** (Mumbai) so BD feeds (Daily Star/TBS) don't chronically hit the 20s deadline from US-East. `maxDuration` 60s.

**Health signal (not deferred):** the poll's loud 503 surfaces failures in the cron dashboard; additionally expose a cheap freshness read (`max(updated_at)`) the owner can eyeball, so a silently-frozen store (rotated key, quota, all-feeds-down) is visible — a load-bearing job must not be blind (a full `poll_runs` table stays out of scope).

### 5.2 The read path — `api/feeds.mjs` (store-aware, guards preserved)

Same endpoint, same `{ headlines, fetchedAt, cached, feedStats }` response, **no client change**.

**Preserve the existing guard chain verbatim, ahead of any new logic** (Finding 6), in both `api/feeds.mjs` and the `server.js` mirror: `applyCors` → OPTIONS 204 → method guard → `checkRateLimit` (`feeds:<ip>`, 60/60s → 429) → JSON parse guard → non-empty `sources` array → **30-source cap**. Then:

1. **Split (server-authoritative):** catalog = `source.id ∈` the server's `lib/sources.json`; everything else = custom. The catalog branch **ignores the client-supplied `feedUrl`** (store-only, keyed by server-side id) — which also closes the catalog SSRF vector.
2. **Catalog → store:** `articlesRepo.selectHeadlines({ sourceIds, category, limit })` via the anon read client, using **only bound query-builder methods** (`.in('source_id', ids).eq('category', cat).order('published_at',{ascending:false}).limit(clamped)`) — never string-built `.or()/.filter()`; `sourceIds` validated as strings; `limit` clamped to a fixed max (Finding: injection + unbounded query).
3. **Custom → live:** `fetchAllFeeds(customSources, { category })` — via `safeFetch` (SSRF preserved on this branch too, Finding 14).
4. Merge, sort by `publishedAt desc`, return.
5. **Cold-vs-empty, throttled fallback (Findings 7 & 8):** an empty *filtered slice* is **not** cold — return it empty. Only live-fall-back to `fetchAllFeeds` when the store is **globally cold** (`articlesRepo.storeIsWarm()` false — no rows at all / first poll hasn't run) **or** the store query threw. The fallback fetches **only the selected catalog sources** (not all 10). Its result is written into the **same in-memory slot as a single-flight cache** (≥2-min TTL) so a cold window or Supabase blip collapses to **one** fan-out per warm instance per TTL — not a per-request thundering herd on the exact POST path the client always uses.

### 5.3 Identity — `lib/articleId.js` (pure-JS, total)

```
canonicalizeUrl(raw):
  try new URL(raw); force scheme https; lowercase host; strip leading 'www.';
  drop fragment; strip trailing slash; remove tracking params
    (utm_*, fbclid, gclid, mc_cid, mc_eid, igshid, ref, ref_src, _hsenc, ...);
  KEEP meaningful params (e.g. ?id=, ?p=, ?story=); sort surviving params.
  on empty / unparseable input -> return null (do NOT throw).

articleId(item):                       // item = { link, guid, title } or a bare url string
  const key = canonicalizeUrl(link) ?? guid ?? title ?? null
  if (key == null) return null-safe-skip   // caller drops truly-empty items (as today)
  return hash64hex(key)                 // 64-bit pure-JS hash -> 16 hex chars
```

- **Total:** never throws on `''`, `tag:...` guids, bare numbers, or titles — preserving today's `link → guid → title` fallback so two different link-less items get two different ids (closes Finding 4). `mapFeedItems`'s `try/catch` no longer silently vanishes guid-only items.
- **Single-sourced lockstep:** `feedParser`, `extractor`, the poller, and the browser all call the same `articleId`, so list-id == reader-id by construction, and width is irrelevant to lockstep. Redirect items are safe (both list and reader hash the pre-redirect `item.link`).
- **Pure-JS hash** (not `node:crypto` md5) so the browser can recompute ids for the IndexedDB re-key (D4). A non-crypto 64-bit hash is fine — this is a dedup key, not a security token.

**IndexedDB re-key (D4, closes Finding 10):** bump `DB_VERSION` in `src/lib/db.js`; the upgrade iterates the `articles`/`history` stores and re-keys each record to `articleId(record.url)` (both stores retain `url`). Without this, a device that favourited pre-2B would show an empty heart on a previously-saved article and could double-save. Old-scheme ids therefore never propagate to Supabase via `syncOnSignIn`.

---

## 6. Security, RLS & secrets

**RLS recipe (explicit, regime-proof — closes both CRITICAL-2 findings).** The migration must not stop at "a SELECT policy": creating a policy does **not** enable RLS, and Supabase's default `anon`/`authenticated` grants otherwise govern (AGENTS landmine #5). Mirror Supabase's documented pattern:

```sql
create table public.articles ( ... , primary key (source_id, id) );
alter table public.articles enable row level security;
revoke all on public.articles from anon, authenticated;
grant select on public.articles to anon, authenticated;
grant select, insert, update, delete on public.articles to service_role;
create policy "articles public read"
  on public.articles for select to anon, authenticated using (true);
-- deliberately NO insert/update/delete policy for anon/authenticated
```

- **Determine the project's default-privilege regime** as a named pre-implementation step (older = auto-grant-all; newer = no-default-grant). The explicit `revoke` + `grant` above is correct under **both**.
- **Verify, don't assume:** after apply, `get_advisors(security)` reports no `rls_disabled_in_public` and no anon write path; an **integration test attempts an anon `INSERT/UPDATE/DELETE` and asserts rejection**; the deploy-verify step confirms reads are genuinely **store-served** (not silently live-falling-back, which would mask a broken read grant).

**Service-role key — structural guards, not a comment (Finding 5 / engineering-discipline #5):**
- `SUPABASE_SERVICE_ROLE_KEY` is read only in `lib/supabaseAdmin.js`, which **throws at import if `typeof window !== 'undefined'`**.
- The write path (`lib/articlesWrite.js`) is the *only* importer of `supabaseAdmin`; the read path imports `articlesRepo` → `supabaseRead` (anon) and never transitively references the admin factory.
- **Enforcing tests:** a grep-test that no `src/**` file imports `supabaseAdmin`/`articlesWrite`; a scan that the built client bundle contains no service-role-key substring. A documented landmine is a live hole until a failing test enforces it.

**Env boundary (Finding 18):** add non-`VITE_` `SUPABASE_URL` + `SUPABASE_ANON_KEY` **now** (not deferred) so **no server code reads a `VITE_`-prefixed name** — establishing the invariant "`VITE_` prefix ⇒ safe-for-browser, no exceptions," which makes any future attempt to `VITE_`-prefix the service key visibly wrong.

**CRON auth:** see §5.1 step 1 (fail-closed-before-compare, `timingSafeEqual`, method guard, no secret logging). `CRON_SECRET` must be set in **Production** (Vercel Cron only fires on Production; the fail-closed default correctly rejects Preview hits).

**CSP untouched (landmine #6):** the browser only calls same-origin `/api/*` (`connect-src 'self'`); `*.supabase.co` is already allowed for the client SDK; the poller→Supabase and read→Supabase calls are server-side, outside browser CSP. Only `crons`/`functions`/`regions` keys change in `vercel.json` — not security headers.

**Public-repo hygiene (landmine #10):** commit/PR prose describes what the guards enforce, never an open-hole timeline.

**Sign-off + pre-flight:** the migration + RLS and the new env vars are AGENTS "out-of-scope-without-sign-off" items — granted at design level (2026-07-11). Applying the migration to prod and adding the Vercel env vars are enumerated for **one pre-flight authorization** at implementation time (CLAUDE.md pre-flight rule). A dedicated **Opus security review** covers the poller, `supabaseAdmin`, the RLS migration, and the read-path guards before merge.

---

## 7. Rollout (no downtime)

0. **Determine the Supabase default-privilege regime** (§6) so the migration's grants are correct.
1. Land the migration (create `articles` with composite PK, indexes, `enable RLS`, explicit revoke/grant, SELECT policy). Confirm via `get_advisors` + an anon-write-rejected check.
2. Add `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` in Vercel (Production; keys needed for reads also in Preview). **Order matters:** table + keys exist before the poller deploys, or the first cron 401s/writes nothing.
3. Deploy the poller + store-aware `/api/feeds` (+ the client IndexedDB re-key).
4. The **throttled live fallback** serves feeds from deploy; the store fills on the first cron (≤20 min) — or trigger immediately with `vercel crons run /api/cron/poll`.
5. **Verify:** store populated; feed genuinely store-served (log marker, not silent fallback); anon write rejected; `get_advisors` clean; both themes/PWA intact; security headers unchanged; a poll failure surfaces as a failed cron run.

No flag day: reads shift from throttled-fallback to store-served as soon as rows exist.

---

## 8. Testing & verification (definition of done)

- **Identity (`lib/articleId.test.js`):** total on `''`/non-URL guid/title; two different link-less items → two ids; stable across `http↔https`, `www`↔bare, trailing slash, param order, and tracking-param variants; keeps meaningful params distinct.
- **Store (repo/write tests, mocked clients):** a single batch with two rows sharing `(source_id,id)` upserts to **one row without throwing** (the CRITICAL); cross-source same-`id` different-`source_id` → two rows; `selectHeadlines` output keys equal `mapFeedItems`; prune removes `>14-day` rows; `storeIsWarm()` true/false logic.
- **Read path:** existing **429** past 60/60s and **400** past 30 sources still fire; empty *warm* slice returns empty (no fan-out); globally-cold triggers fallback for **selected** sources only; fallback is cached/single-flight; a custom source with `feedUrl=http://169.254.169.254/…` is rejected by `safeFetch`; a `category` carrying PostgREST filter syntax injects nothing.
- **Security:** anon `INSERT/UPDATE/DELETE` on `articles` rejected; no `src/**` imports `supabaseAdmin`/`articlesWrite`; built bundle has no service-role key; CRON auth (unset→401, wrong/absent header→401, correct→200).
- **Client migration:** IndexedDB re-key upgrade maps a pre-2B favourite (old id) to the new id and preserves it; the reader shows it favourited.
- **Regression:** existing **68 tests stay green** (client contract unchanged). `npm run build` exit 0. Lint adds **zero** new errors over the 3-error baseline (cite exit codes; never pipe gate commands).
- **Security review (Opus)** + **deploy-verified live** on `masthead-news.vercel.app` (deploy ≠ merge).

---

## 9. Explicitly out of scope for 2B

Full-article body storage / pre-extraction (2C, on-save); promoting custom sources to a server table + polling them (2C/2D); any client UI change; a `poll_runs` observability table (a loud 503 + `max(updated_at)` freshness read suffice for v1); backfilling the *existing* user tables' DDL into migrations; premium/secret feeds (2E); per-source cadence tuning / time-of-day polling.

---

## 10. Open items carried forward

- 2C adds on-save full-text body storage on top of this store.
- **PWA-cache drift (2D):** a service-worker-cached client and an updated server can disagree on which ids are "catalog" after a catalog rename — 2D should handle slug changes with aliases, not hard renames.
- The 3 baseline `set-state-in-effect` lint errors remain out of scope.
- If the very-high runaway retention guard is ever added, order it by `first_seen_at` (or `coalesce(published_at, first_seen_at)`), never raw `published_at` (which `parseDate` stamps as `now()` for dateless items).

---

## 11. Success criteria recap

Store-served catalog feed, refreshed ~20 min, honest 14-day retention; unchanged + still-guarded client contract; zero functional regression incl. pre-2B saved articles; provably write-locked public table; a poller that fails loudly; deploy-verified live.

---

## 12. Review hardening log

**2026-07-11 — 3-lens adversarial spec review** (data-integrity · security/RLS · ops/failure-modes), fresh-context Opus reviewers, before the owner review gate. 21 findings; all confirmed and folded into this revision. Highlights: **2 CRITICAL** — (a) bulk upsert with no in-batch dedupe crashes on same-`id` rows within one poll (fixed via composite PK `(source_id,id)` + in-memory batch dedupe), (b) RLS never actually enabled ⇒ world-writable table (fixed via explicit `enable RLS` + `revoke`/`grant` + anon-write-rejected test). **HIGH** — cross-source collapse hiding a selected source's articles (fixed by composite PK); `canonicalizeUrl` throwing on link-less items (fixed by total function); service-role "server-only" unenforced (fixed by tripwire + import-boundary + bundle tests); read-path rewrite dropping existing guards (fixed by preserve-verbatim); cold-vs-empty conflation + unthrottled fallback herd (fixed by warmth probe + single-flight cache); silent poller failure (fixed by loud 503 + freshness read). **MED/LOW** — IndexedDB favourite-orphan (fixed by pure-JS hash + re-key), 200/source cap breaking the 14-day promise (cap dropped), CRON `"Bearer undefined"` bypass + timing (fixed), read-path SSRF unstated (pinned), BD-feed region (pinned `bom1`), snake→camel mapping, query-injection posture, non-`VITE_` env aliases, fallback-scope = selected-only.
