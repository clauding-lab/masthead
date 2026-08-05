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
| Unit tests (vitest, 813 tests as of 3B, incl. `api/**`) | `npm test` |
| Tests, watch mode | `npm run test:watch` |
| Lint (baseline: 3 pre-existing errors + 5 warnings, all in `src/`; zero NEW is the gate) | `npx eslint src lib api server.js scripts email-worker` |
| Catalog feed health — manual, pre-merge, deliberately NOT in CI (36 network calls) | `npm run verify-catalog` |
| Premium-table custody probe — manual, network, requires `20260719_create_user_premium_feeds.sql` applied; expects all-PASS anon denials (optional concurrent-cap block via `SUPABASE_SERVICE_ROLE_KEY` + `PROBE_USER_ID`) | `npm run probe-premium` |
| Preview production build | `npm run preview` |

Gotchas:
- `npm run dev` uses `concurrently` to run `node server.js` (the API) and `vite` (the frontend) side by side. The frontend talks to the local API; in prod the same routes are Vercel functions.
- **Lint currently exits 1** on exactly 3 pre-existing `react-hooks/set-state-in-effect` errors in untouched components (`PageTransition`, `SavedPage`, `HistoryPage`). That is the known baseline — new work must add **zero** new errors, but the non-zero exit itself is not a regression. Fixing those 3 is behaviour-risky and out of scope unless explicitly asked.

## Release flow

No CI workflows yet (`.github/workflows/` does not exist). Release = **merge to `main` → Vercel auto-deploys production** via the Git integration; preview deploys are created per branch/PR. Therefore **deploy is a separate fact from merge** — after a merge, verify the live artifact on `https://masthead-news.vercel.app` (not the `*-clauding-labs-projects.vercel.app` aliases, which sit behind Vercel Deployment Protection SSO and 302 for public checks). Pre-merge smoke: `npm test` green, `npm run build` exit 0, lint adds no new errors.

## Coding style

- **JavaScript only** (JS/JSX, ESM — `"type": "module"`). No TypeScript. Use JSDoc where a type genuinely clarifies.
- **Lint:** eslint flat config (`eslint.config.js`) — browser globals for `src/`, Node globals for `lib/`, `server.js`, `api/`, `vitest.config.js`; `email-worker/` is explicitly `ignores`-excluded from the browser-globals block and gets its own minimal Cloudflare-Workers-runtime globals ONLY (`fetch`, `Response`, `console` — no Node globals, it's not Node, and no browser globals either — a stray `document`/`window` reference there is a real `no-undef` lint error, not a silent pass).
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
16. **Kind-scoped feed surfaces must NEVER fall back to the kind-agnostic catalog.** All request selectors in `src/stores/feedStore.js` set `fallbackToCatalog: false`; empty selection renders an empty state / picker, it does not call the GET catalog path (`getCatalogHeadlines` serves ALL kinds — the server is deliberately kind-blind). "Restoring" the pre-2D zero-sources fallback reintroduces blog/social leakage into News "All" with wrong link behavior. Test-enforced per surface in `feedStore.test.js`. (Final-review catch, 2026-07-18.) 2E amendment: the guard condition is `sources.length === 0 && premiumIds.length === 0 && !fallbackToCatalog` — a premium-only surface MUST still fetch. Both directions are pinned by `src/stores/feedStore.test.js`.
17. **Never hard-rename a catalog slug in `lib/sources.json`** — change `id` and add the old id to `aliases` in the same commit. `lib/catalogIndex.js` resolves aliases server-side (feedService POST + GET) and heals client localStorage on boot; store rows under the old slug age out via the 14-day prune. A hard rename strands service-worker-cached clients AND orphans user selections. The structural test (`lib/catalog.test.js`) forbids alias/id collisions.
18. **Premium AND inbox records must NEVER reach the article extractor** (`/api/extract` returns the publisher's paywall teaser for premium, or the app's own SPA shell for an inbox permalink — either would be silently persisted as if it were the real body). Enforcement is layered: (a) the extractor call itself — `src/lib/api.js#extractArticle` refuses inbox permalinks as its first statement, so ANY path that reaches the funnel is covered, including paths that skip the record-shaped seams (History reopens, retry buttons); (b) three record-shaped seams in `src/lib/library.js` — `saveArticle`'s extract branch, `retrySave`, `attachBodyToSaved` — via `isInboxRecord` for inbox and the `savedVia: 'premium'` + `sourceId` marker for premium; (c) `resolveReaderSource`'s `'premium'`/`'shell'` modes. **`savedVia` does NOT survive a cloud sync round-trip** (`localFromSavedRow` hardcodes `'sync'`), so the durable half of the inbox predicate is the URL shape (`isInboxPermalink` — deliberately prefix-tolerant and origin-independent; tightening it can silently open the ban). Inbox reads also never enter History (spec §11 exclusion — guard on ReaderPage's history effect). Test-pinned in `src/lib/library.test.js`, `src/lib/api.test.js`, and `src/pages/ReaderPage.test.jsx` with `not.toHaveBeenCalled()` assertions, including the post-round-trip direction. (Task-review catches, 2026-07-19 + 2026-08-05.)
19. **Component tests use the in-repo zero-dep harness, not @testing-library/react** — RTL is deliberately NOT installed (no new deps without owner sign-off). `src/test/domTestUtils.js` provides `renderComponent`/`fireClick`/`fireChange`/`fireBlur`/`fireClickAsync` (real `createRoot` into `document.body`, native-setter input events, `focusout` for blur); `vitest.config.js`'s `esbuild.jsx: 'automatic'` makes `.jsx` test files work at all — removing it breaks every component test with "React is not defined". (2026-07-19.)
20. **A store that must be populated for other surfaces to work gets its load trigger in `authStore.initAuth`, not a page effect.** `premiumStore.loadFeeds()` wired only into SettingsPage left the entire premium feature silently inert on normal boot (feeds start `[]`, so kind selectors returned `[]` everywhere) — the final-branch-review catch of this slice, same composition-bug class as landmine 16. Pattern: `bootstrapPremiumFeeds()` in `src/stores/authStore.js` fires on BOTH session-restore and fresh sign-in, then refetches affected kind surfaces; boot-sequencing pinned in `src/stores/authStore.test.js`. (Final-review catch, 2026-07-19.)
21. **User choice beats suggestion — and needs a test where they conflict.** `suggestKind` (and any future auto-fill) may only write state the user has NOT explicitly set: `AddSourceModal`'s `kindTouched` latch gates both suggestion sites (discovery success + premium-input blur). Wiring a suggester into `onBlur`/on-success without such a latch silently overrides the user's pick, because submit buttons always blur the field first. Pinned by "an explicit kind choice survives premium URL blur" in `AddSourceModal.test.jsx` — keep that conflict-direction test when touching the modal. (Live-drive catch, 2026-07-30; see AGENT_LEARNINGS.)
22. **`window.confirm` freezes in-browser automation drives** — native dialogs block the renderer until a human dismisses them. The only site is `PremiumSourceRow`'s delete. Automation must delete premium rows via the authed API (`DELETE /api/premium-feeds` with `{id}`), never the row's Remove button. Open UX follow-up (owner call): replace with an in-app confirm; custom-source rows currently delete with no confirmation at all. (2026-07-30.)
23. **The newsletter inbox's ingest path is INSERT-only** (`lib/inboxRepo.js#insertMessage`). The DB's `user_inbox_messages_no_undelete` trigger (`supabase/migrations/20260731_create_inbox.sql`) binds `service_role` too, so nothing may `ON CONFLICT DO UPDATE SET deleted_at = null` or otherwise upsert into `user_inbox_messages` — that would attempt to resurrect a tombstoned row and the trigger would reject it. A dedupe-key collision is detected (23505 → `'duplicate'`), never overwritten. (Phase 3, spec §4.2.)
24. **Email Worker verdicts are header-gated, not status-gated.** `email-worker/handler.js#verdictFromResponse` trusts a response as OUR verdict only when it carries `x-masthead-ingest: 1` — every action, including accept, requires that header. Any code from `/api/inbox-ingest` NOT in `REJECT_CODES` (`unknown_recipient`, `message_too_large`, `unparseable`, `over_quota_final`) falls through to `defer`, never a bounce — an infra condition (5xx, a foreign/misrouted response, an unrecognised future code) must never permanently reject legitimate mail. (Phase 3, spec §3.)
25. **The inbox purge cron is the ONLY hard-delete chokepoint**, and only for tombstoned rows. `lib/inboxPurge.js` re-asserts `deleted_at is not null` on every delete's filter chain even when the id list handed in should already be tombstone-scoped (belt and braces) — a live row must be unreachable by construction. Nothing else in Phase 3 hard-deletes `user_inbox_messages`; everywhere else a delete is a `deleted_at` tombstone. (Phase 3, spec §5.3.)
26. **Control bytes (NUL etc.) are never typed as literal bytes into source** — not even as a Unicode escape sequence, which has its own transcription hazard (some tooling silently decodes the escape to the raw byte when a file is touched). Construct them programmatically instead (`String.fromCharCode(0)`, `String.fromCodePoint(...)`) and verify every touched file is byte-clean with `perl -0777 -ne 'print tr/\x00//' <file>` before committing. (Phase 3 — repeated transcription incidents during Tasks 5/7; see AGENT_LEARNINGS.)
27. **`MAX_RAW_BYTES` lives in `lib/inboxConfig.js` (source of truth) and is hand-duplicated in `email-worker/worker.js`** (a separate Cloudflare deployable that cannot `import` from `lib/`). `email-worker/maxRawBytes.test.js` asserts the two values are equal — change both together, and let the test confirm it; a lib-side raise with no matching Worker edit would have the Worker permanently bounce "Message too large" on mail the API would actually accept. (Phase 3.)
28. **Remote-resource blocking must be default-closed URL resolution, never a scheme regex.** A protocol-relative URL (`//tracker.example/x.jpg`) carries NO scheme — a `/https?:/i` test passes it straight through BOTH sanitisation layers, and the CSP's `img-src https:` permits the resulting fetch. `src/lib/emailImages.js#isRemote` resolves via `new URL(value, origin)` and blocks everything not provably safe (`data:` or same-origin) — including unparseable values. `srcset` is split per-candidate. Vectors covered: `img[src|srcset]`, `source` anywhere, `video[poster|src]`, `audio[src]`, `track[src]`, legacy `background` attributes. The style-attribute `url()` family (5 properties) is closed at the SERVER sanitiser's allowlist instead — pinned in `lib/sanitizeEmail.test.js`; do not bolt a regex onto the client (CSS escapes like `\75 rl(` defeat naive stripping). (Security-review catch, 2026-08-05.)
29. **DOMPurify's `html` profile INCLUDES the `<style>` element** — it must be named explicitly in `FORBID_TAGS` (both `CONFIG` and `EMAIL_CONFIG` in `src/lib/sanitize.js` do). A top-level `<style>` disappearing in a quick test proves nothing: the HTML parser hoists a leading `<style>` into `<head>` and DOMPurify returns `body` — a position artifact, not policy. Pin with a NESTED `<style>` fixture. (Security-review catch, 2026-08-05.)
30. **`isolation`/`overflow`/`position: relative` do NOT contain `position: fixed` descendants** — only `contain` (layout/paint), `transform`, `filter`, or `perspective` on an ancestor creates the containing block. `.email-content` (`src/styles/email-content.css`) carries `contain: layout paint` for exactly this; its `isolation: isolate` + `z-index: 0` half keeps app chrome (header z-40, tab bar z-50) painting above hostile email content. Browser-verified: without `contain`, a `position:fixed; inset:0` element in email HTML covers the full viewport. Do not "simplify" either half away. (Security-review catch, browser-verified 2026-08-05.)
31. **`ConfirmSheet` is the repo's modal focus-discipline reference** — focus trap (Tab/Shift+Tab), Escape-cancels, initial focus on Cancel, focus RESTORED to the trigger on every close route, and a two-effect split (`[open]` owns focus; `[open, onCancel]` owns only the keydown listener) so a parent re-render with a fresh callback identity cannot steal focus mid-interaction. `AddSourceModal` predates this and has neither trap nor restore — a known asymmetry, not a pattern to copy. New modals follow `ConfirmSheet`. (A11y-review catch, 2026-08-05.)

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
