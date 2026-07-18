# AGENTS.md — Masthead

Operational rules for AI coding agents (Claude Code, Cursor, Codex CLI, etc.) working in this repo. Read this in full before making any code change.

## What this project is

Masthead is a React 19 + Vite PWA news reader — a fast, private, free reading surface over RSS feeds and full-article extraction. Readers pick sources, browse headlines by category, open a clean reader view (Readability + sanitised HTML), favourite and save articles, and keep history. Data is local-first (IndexedDB) with optional Supabase sync when signed in (Google auth). It ships as a single Vercel deployment at **masthead-news.vercel.app**, and **this GitHub repo is PUBLIC**. Server work runs as Vercel serverless functions (`api/*.mjs`) in production and a local Hono dev server (`server.js`) in development.

Owner: solo dev (Adnan, Bangladesh, UTC+6). Vibe-coded — Adnan directs AI agents, does not hand-write code himself. All explanations, summaries, and prose should be in plain English with technical terms briefly explained; never assume Adnan reads code.

## Repository structure

```
api/          Vercel serverless handlers (feeds, extract, save-url, discover-rss, cron/poll) — prod server surface
server.js     Local Hono dev server — mirrors api/ for `npm run dev`; imports the SAME lib/ modules
lib/          Shared server-side modules used by BOTH api/ and server.js (so dev/prod can't drift):
              urlGuard (SSRF), httpGuards (CORS + clientIp), rateLimit, sanitizeServer,
              feedParser, extractor, sources.json (source registry), articleId (shared identity,
              also browser-imported), feedService (store-aware reads), articlesRepo/articlesWrite
              (Supabase read/write split), supabaseRead/supabaseAdmin (anon vs service-role clients),
              pollRunner + cronAuth (cron poller). *.test.js colocated.
src/          React app
  components/ Presentational UI (cards, tabs, modals, bars)
  pages/      Route screens (Feed, Reader, Onboarding, Favorites, History, Settings)
  stores/     Zustand state (feedStore, authStore, articleStore, settingsStore)
  lib/        Client data layer: db (IndexedDB/idb), localData, sync (Supabase),
              sanitize (DOMPurify), supabase, api
  hooks/  styles/
supabase/migrations/   SQL migrations (applied to the prod Supabase project)
vercel.json            SPA rewrites, CSP + security headers, function maxDuration
docs/superpowers/      specs + plans (e.g. the Phase 1 Harden spec/plan)
```

## Build, Test, Run

| Goal | Command |
|---|---|
| Dev loop (API + frontend together) | `npm run dev` |
| Frontend only | `npm run dev:frontend` |
| Local API server only | `npm run dev:api` |
| Build for release | `npm run build` (includes `scripts/check-bundle.mjs` service-role leak scan) |
| Unit tests (vitest, 194 tests incl. `api/**`) | `npm test` |
| Tests, watch mode | `npm run test:watch` |
| Lint (baseline: 4 pre-existing errors — 3 set-state-in-effect + 1 `tailwind.config.js` no-undef — plus 5 warnings; zero NEW is the gate) | `npx eslint src lib api server.js scripts` |
| Catalog feed health — manual, pre-merge, deliberately NOT in CI (36 network calls) | `npm run verify-catalog` |
| Preview production build | `npm run preview` |

Gotchas:
- `npm run dev` uses `concurrently` to run `node server.js` (the API) and `vite` (the frontend) side by side. The frontend talks to the local API; in prod the same routes are Vercel functions.
- **Lint currently exits 1** on exactly 3 pre-existing `react-hooks/set-state-in-effect` errors in untouched components (`PageTransition`, `SavedPage`, `HistoryPage`). That is the known baseline — new work must add **zero** new errors, but the non-zero exit itself is not a regression. Fixing those 3 is behaviour-risky and out of scope unless explicitly asked.

## Release flow

No CI workflows yet (`.github/workflows/` does not exist). Release = **merge to `main` → Vercel auto-deploys production** via the Git integration; preview deploys are created per branch/PR. Therefore **deploy is a separate fact from merge** — after a merge, verify the live artifact on `https://masthead-news.vercel.app` (not the `*-clauding-labs-projects.vercel.app` aliases, which sit behind Vercel Deployment Protection SSO and 302 for public checks). Pre-merge smoke: `npm test` green, `npm run build` exit 0, lint adds no new errors.

## Coding style

- **JavaScript only** (JS/JSX, ESM — `"type": "module"`). No TypeScript. Use JSDoc where a type genuinely clarifies.
- **Lint:** eslint flat config (`eslint.config.js`) — browser globals for `src/`, Node globals for `lib/`, `server.js`, `api/`, `vitest.config.js`.
- **Tests:** vitest, `*.test.js` colocated next to the module; `fake-indexeddb` for db tests.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, etc.), imperative mood. No `Co-Authored-By: Claude` lines — attribution is disabled globally.
- **Files:** focused modules; ~400 lines typical, 800 max.

## Key conventions

- **Server-side guards live in `lib/`, imported by BOTH `api/*.mjs` and `server.js`.** SSRF (`urlGuard`), CORS + client IP (`httpGuards`), rate limiting (`rateLimit`), server HTML sanitising (`sanitizeServer`), feed parsing (`feedParser`), extraction (`extractor`). Never inline guard logic into a single handler — that reintroduces the dev/prod drift this layer exists to prevent.
- **API handler shape:** default-export `async function handler(req, res)` (Vercel Node signature). Order inside every handler: `applyCors` → OPTIONS 204 → method guard → `checkRateLimit` → input validation → work. Use `api/extract.mjs` as the reference.
- **Two sanitisation layers by design:** the server sanitises extracted HTML with `sanitize-html` (`lib/sanitizeServer.js`); the client re-sanitises at render with DOMPurify (`src/lib/sanitize.js`). Keep both — defence in depth.
- **Local-first data:** the client persists to IndexedDB via `src/lib/db.js` (`idb`) and syncs to Supabase via `src/lib/sync.js` only when signed in. Storage is consent-aware. Don't duplicate server state into stores needlessly.
- **State:** Zustand stores in `src/stores/`. **Source registry:** `lib/sources.json`.
- **Article identity is single-sourced in `lib/articleId.js`** (pure JS, 16-hex, canonicalized-URL hash) — used by `feedParser`, `extractor`, the cron poller, AND the browser (IndexedDB). Never re-derive ids elsewhere; feed-item identity falls back link → guid → title, so pass a caller-supplied id through save paths rather than re-hashing a possibly-empty url.
- **Saves go through `src/lib/library.js#saveArticle`** (paste / share-target / heart alike): local-first IndexedDB, then cloud upsert under the user's own JWT to `user_saved_articles`. Deletes are `deleted_at` tombstones, never row deletes; shell (body-less) cloud upserts must stay metadata-only.

## Known landmines (read before touching these areas)

1. **Shared `lib/` dual-consumption.** Every server-side guard is imported by both `api/*.mjs` (prod) and `server.js` (dev). Edit the `lib/` module, not a copy — inlining logic into a handler silently drifts dev and prod apart.
2. **Upstash dual env-var naming (`lib/rateLimit.js`).** The limiter reads *both* `UPSTASH_REDIS_REST_URL/TOKEN` (the `@upstash/redis` `fromEnv()` convention) and `UPSTASH_REDIS_KV_REST_API_URL/TOKEN` (what the Vercel Upstash Marketplace integration actually injects). Do **not** "simplify" to one set — the live integration injects the `KV_REST_API_*` names; dropping that branch silently disables rate limiting (see landmine 3). This was PR #2.
3. **Rate limiter fails OPEN.** `checkRateLimit` returns `{ allowed: true }` if Upstash throws, and falls back to a per-instance in-memory limiter when Upstash is unconfigured (dev). Intentional — availability over strict limiting — but it means a broken/misconfigured Upstash means *no shared rate limiting in prod, silently*. Switching to fail-closed is a deliberate security decision, not a cleanup.
4. **Supabase auth token lives under `sb-*` localStorage keys, not `masthead-*`.** Any sign-out / data-clear path must sweep BOTH prefixes. Sweeping only `masthead-*` leaves the JWT behind; if `signOut()` fails on the network, the next visitor on a shared device gets the previous user's session auto-restored. (Review-caught — see AGENT_LEARNINGS 2026-07-11.)
5. **Postgres `GRANT` to `PUBLIC` ≠ grant to `anon`/`authenticated`.** Revoking `EXECUTE` from named roles is a no-op while the default `PUBLIC` grant stands — `has_function_privilege` still returns true. Always `revoke ... from public` too, and verify with `has_function_privilege` / the function ACL, not "migration applied". (Review-caught — see AGENT_LEARNINGS + auto-memory `postgres-revoke-public-gotcha`.)
6. **CSP is hand-maintained in `vercel.json`.** `script-src` is `'self'` only — no inline scripts, no CDNs. `connect-src` allows `'self'` + `https://*.supabase.co` only. Any new inline script, external script, image/font origin, or API host is *silently blocked in prod* until you add it to the CSP block. Test CSP changes on the live domain, not just locally.
7. **HSTS is intentionally `max-age=31536000` (1 year)** in `vercel.json`, not Vercel's default 2-year value. Set explicitly; don't let a platform default override it silently.
8. **`feedParser` returns `{ headlines, stats }`**, not a bare array (a Harden-era breaking change; all 4 consumers were updated). A new consumer expecting an array will break.
9. **SPA rewrite in `vercel.json`** routes everything except `/api/*` to `index.html`. A new *non-SPA* top-level path needs an explicit rewrite exception or it just serves the app shell.
10. **This is a PUBLIC repo.** Commit messages, PR bodies, and issues must NOT narrate currently-open production vulnerabilities or exploitation windows ("hole open until X deploys"). Describe hardening by what it enforces, neutrally. (A PR body was classifier-blocked for this — see AGENT_LEARNINGS 2026-07-11.)
11. **supabase-js returns `{ error }` — it never throws on DB errors.** A `try/catch` around an `await supabase...upsert()` catches nothing; you MUST inspect the returned `error`. Worse, a batch (array) upsert is ONE SQL statement: a single row violating a CHECK/NOT NULL aborts EVERY row in the batch, silently if the error is discarded. Pre-filter rows that can violate constraints (see `isCloudSyncable` in `src/lib/sync.js`) and always check `error`. (Review-caught HIGH, 2026-07-18 — one link-less item would have stranded a user's whole cloud library forever.)
12. **The Supabase project is on the OLD auto-grant default-privilege regime** — `pg_default_acl` grants `anon`/`authenticated` full privileges on every new table at CREATE. Every new-table migration MUST include explicit `revoke all ... from public, anon, authenticated` before its grants; RLS policies alone do not remove the grants. Follow `20260718_create_articles.sql` / `20260719_create_user_saved_articles.sql` verbatim as the pattern (verified against prod 2026-07-18). Extends landmine 5, which covers the same trap for functions.
13. **Retiring a table = TWO migrations, not one.** Create-and-copy before the app deploy; `drop` only in a second migration applied after the new deploy is live-verified. The currently-deployed app keeps querying the old table until the deploy completes — dropping early silently breaks its writes (supabase-js swallows the error per landmine 11). Pattern: `20260719_create_user_saved_articles.sql` + `20260719_drop_user_favorites.sql` (2026-07-18).
14. **Prod DDL cannot be agent-run.** The Claude Code permission classifier blocks `supabase db query --linked` DDL regardless of owner approval in chat. Standing pattern: the agent stages the migration file and enumerates it in the pre-flight; the OWNER executes `! supabase db query --linked -f supabase/migrations/<file>` in-session; the agent then verifies via read-only queries (`to_regclass`, grants/policies, live REST probes). Never assume a pasted command executed — verify with a read (a pasted command once arrived as chat text and never ran, 2026-07-18).
15. **rss-parser silently drops `media:*` fields unless `customFields` is configured** (`lib/feedParser.js` `parserOptions`). Removing that config makes `extractThumbnail`'s media branches dead code again for EVERY feed — and unit tests that hand-feed objects will stay green while it happens. Any new feed producer type (a new platform's RSS flavor) requires a REAL captured payload fixture in `lib/__fixtures__/` run through `new Parser(parserOptions)` in `lib/feedParser.test.js`, not a hand-written one. (Caught 2026-07-18 — the media branches had been dead since 2B; see AGENT_LEARNINGS.)
16. **Kind-scoped feed surfaces must NEVER fall back to the kind-agnostic catalog.** All request selectors in `src/stores/feedStore.js` set `fallbackToCatalog: false`; empty selection renders an empty state / picker, it does not call the GET catalog path (`getCatalogHeadlines` serves ALL kinds — the server is deliberately kind-blind). "Restoring" the pre-2D zero-sources fallback reintroduces blog/social leakage into News "All" with wrong link behavior. Test-enforced per surface in `feedStore.test.js`. (Final-review catch, 2026-07-18.)
17. **Never hard-rename a catalog slug in `lib/sources.json`** — change `id` and add the old id to `aliases` in the same commit. `lib/catalogIndex.js` resolves aliases server-side (feedService POST + GET) and heals client localStorage on boot; store rows under the old slug age out via the 14-day prune. A hard rename strands service-worker-cached clients AND orphans user selections. The structural test (`lib/catalog.test.js`) forbids alias/id collisions.

## Communication & timezone

- All times in **BDT (UTC+6)**, labelled.
- Plain-English explanations of technical terms — Adnan reads but doesn't write code.
- No emojis in code or commits unless requested.
- Short, scannable updates — often read on mobile.

## Out-of-scope behaviors

Do not, without explicit user sign-off:

- Edit the CSP or security headers in `vercel.json` (security-critical).
- Write or apply Supabase migrations, RLS policies, or grants (prod DB).
- Change the fail-open/fail-closed posture of the rate limiter, the SSRF allowlist, or the CORS allowlist.
- Change prod env values (`ALLOWED_ORIGINS`, `SAVE_URL_TOKEN`, Upstash/Supabase keys).
- Add new dependencies in `package.json`.
- Push directly to `main` (branch → PR) or run `git push --force` against any branch.
- Skip hooks (`--no-verify`, etc.).

For everything else, see `VISION.md` for what auto-merges vs needs sign-off.

## Cross-cutting rules

Adnan's global rules live in `~/.claude/CLAUDE.md` (loaded automatically by Claude Code). When that file conflicts with this one, this file wins because it's project-specific.
