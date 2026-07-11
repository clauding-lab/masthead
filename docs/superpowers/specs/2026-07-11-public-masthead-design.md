# Public Masthead — Design Spec

**Date:** 2026-07-11
**Status:** Approved direction; Phase 1 (Harden) designed in detail. Phases 2–4 get their own specs when they start.
**Owner:** Adnan (product) / AI agents (implementation)

---

## 1. Vision

Turn Masthead from a personal PWA news reader into a public, free-to-use reading app: users bring their own RSS feeds (with a curated suggested catalog), read blogs and newsletters in a dedicated space, save any link for later, and follow news organizations' social accounts — all in a calm, Reeder/Things-grade interface. Monetization comes later, when the app ships to the app stores (Apple/Google handle payments, which sidesteps the unavailability of Stripe to Bangladesh-based merchants).

**Positioning:** free public PWA now → paid app-store product later. The email newsletter inbox (Phase 3) is the future paid differentiator — it is what Meco and Readwise Reader successfully charge for.

## 2. Decisions log (2026-07-11 brainstorm)

| Decision | Choice | Notes |
| --- | --- | --- |
| Audience | Real product, paid/freemium eventually | Not a portfolio piece |
| Newsletter ingestion | Email ingestion ships in v1 roadmap (Phase 3) | User overrode RSS-first recommendation; bolder, costlier |
| Platform | PWA-first; Capacitor wrap for stores later | No native rewrite |
| Monetization | PWA free; monetize only at app-store phase | No billing plumbing in any PWA phase |
| Payments geography | Deferred to store phase | Apple/Google payouts reach Bangladesh; Stripe does not |
| Database | Stay on Supabase Pro as-is | Free-org transfer (2 free projects allowed alongside Pro; 1–2 min downtime) documented as an available cost lever |
| Paywalled sites | Sanctioned approach only | Subscriber premium feed URLs (e.g. The Verge full-text RSS for subscribers) + paid newsletters via email inbox + bookmarklet capture from the user's own logged-in browser. **Never** store publisher credentials or scrape behind paywalls server-side |
| Social feeds | Bluesky + Mastodon in v1 (both expose native RSS per account) | X/Threads deferred: no free API access |
| UI/UX direction | Reeder/Things-like: calm, typography-first, gesture-driven | Governs Phase 2 redesign and all later UI |
| Sequencing | A: Harden → Reader → Email → Launch | Each phase = own spec → plan → PR cycle |

## 3. Constraints

- Solo non-programmer owner directing AI agents; every phase must end in a verifiable, shippable state.
- Free public product = the owner eats running costs → every phase includes abuse/cost caps.
- Supabase free-tier limits are NOT currently binding (staying on Pro), but Phase 2's stored-articles design must include pruning regardless (unbounded growth was a review finding).
- Vercel plan: if currently on Hobby, review commercial-use terms at the monetization phase.
- No tests exist today. Phase 1 introduces the test harness (vitest); coverage grows per phase.

## 4. Roadmap

### Phase 1 — Harden (detailed design in §5)
Fix all 3 CRITICALs + 6 HIGHs from the 2026-07-11 51-agent review, plus Supabase advisor items. No feature work. Gates everything else.

### Phase 2 — Reader
- **Redesign** to the Reeder/Things design language (typography-first, calm, gestures). Use frontend-design/impeccable skills; both themes intentional.
- **Blogs & Newsletters section**: dedicated space distinct from the news feed, fed by RSS (covers most blogs, Substack/Ghost/beehiiv newsletters).
- **Server-side article storage + background polling** (Vercel cron → Supabase), replacing fetch-live-on-request. Includes article pruning/retention policy. This is the foundation the email inbox later requires.
- **Read-it-later**: paste any URL, or share into the PWA (Web Share Target). Content stripped via the existing extractor and saved. Revives the currently-dead `save-url`/`pending` subsystem found in review.
- **Premium subscriber feeds**: a feed URL is treated as secret-bearing (e.g. The Verge subscriber full-text feed); stored per-user, never shown in full, never shared into the public catalog.
- **Suggested catalog**: expanded curated registry including Bluesky/Mastodon accounts of major outlets (native RSS: `bsky.app/profile/<handle>/rss`, `<mastodon-instance>/@user.rss`).
- **Bookmarklet capture**: saves the rendered article from the user's own logged-in browser tab to their read-it-later library (covers paywalled pages without subscriber feeds).

### Phase 3 — Email ingestion
- Unique per-user ingest address (e.g. `<slug>@in.masthead.app`); newsletters (free or the user's paid subscriptions) delivered there land in the user's inbox, parsed to clean reading view.
- Provider evaluation (Cloudflare Email Routing + Worker vs Postmark/Mailgun inbound webhooks) happens in this phase's spec.
- Per-user quotas (senders, message size, storage) from day one.

### Phase 4 — Launch
- Landing page, privacy policy + ToS, email sign-in (magic link / OTP — Google-only excludes too many people), invite-capped beta, basic analytics, error monitoring.

### Phase 5 (later, out of current scope) — Stores & monetization
- Capacitor wrap, App Store / Play Store, IAP-based subscription. Payments geography resolved by store payouts.

## 5. Phase 1 — Harden: detailed design

One branch, one PR. The app looks identical after; it just stops being dangerous. All findings below are from the adversarially-verified 2026-07-11 review.

### 5.1 XSS fix (CRITICAL)

Article HTML from `@mozilla/readability` is rendered raw via `dangerouslySetInnerHTML` (`src/pages/ReaderPage.jsx:212`). Readability is not a sanitizer (keeps event-handler attributes, `<iframe>`, `javascript:` URLs).

- **Client (load-bearing):** sanitize with DOMPurify immediately before render in ReaderPage. Also covers hostile HTML already cached in IndexedDB on existing devices.
- **Server (defense-in-depth):** sanitize in `lib/extractor.js` before returning. Attempt DOMPurify over the existing linkedom window; if incompatible, use `sanitize-html`. Decide during implementation with a test proving hostile markup is stripped.
- **CSP header** via `vercel.json`: `default-src 'self'`; `script-src 'self'`; `style-src 'self' 'unsafe-inline'`; `img-src 'self' https: data:`; `connect-src 'self' https://*.supabase.co`; `frame-src 'none'`; `object-src 'none'`; `base-uri 'self'`; `worker-src 'self'` (PWA service worker must keep working — verify after deploy).

### 5.2 Endpoint lockdown (CRITICAL)

`api/extract.mjs`, `api/discover-rss.mjs`, `api/save-url.mjs`, and `POST /api/feeds` fetch caller-supplied URLs with only `new URL()` shape validation, CORS `*`, no auth, no rate limit, and echo `err.message`.

- **New shared module `lib/urlGuard.js`** used by all four:
  - scheme allowlist: `http:`/`https:` only;
  - resolve hostname; reject loopback, RFC1918 private, link-local (incl. `169.254.169.254` cloud metadata), `.internal`, and IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`);
  - follow redirects manually (max 3), re-validating every hop;
  - request timeout and response-size cap.
- **CORS:** replace `*` with an origin allowlist (production domain + localhost dev).
- **Rate limiting:** per-IP via Upstash Redis free tier (`@upstash/ratelimit`). IP-based, not auth-based — feeds must work signed-out.
- **Errors:** generic client-facing messages; details only in server logs.
- `server.js` (local dev Hono server) mirrors the same guards to avoid dev/prod drift.

### 5.3 Sign-out data clearing (CRITICAL)

`signOut()` (`src/stores/authStore.js:48`) only clears the Supabase session. Local IndexedDB favorites/history are not user-scoped, so the next account on the device inherits — and `syncOnSignIn` re-uploads — the previous user's data.

- On sign-out: clear the IndexedDB stores (favorites, history), remove all `masthead-*` localStorage keys, reset in-memory zustand stores.
- Per-user namespacing of local data is deferred to Phase 2 (local schema changes there anyway).

### 5.4 The six HIGHs

1. **Frozen session persistence** (`src/lib/supabase.js`): `persistSession` is computed once at module load from a localStorage consent flag, locking first-time users (and consent-decliners) into memory-only sessions. Fix: pass a custom storage adapter that checks the consent flag at call time (no client re-creation mid-session).
2. **Onboarding source picks lost on Google path** (`src/pages/OnboardingPage.jsx:76`): persist selection + onboarded flag *before* the OAuth redirect.
3. **Feed race** (`src/stores/feedStore.js:41`): request sequence token; stale responses discarded.
4. **History sync one-way** (`src/lib/sync.js:59`): add remote→local download; wire the dead `pushHistoryEntry` (`sync.js:115`) into ReaderPage's read event.
5. **One malformed item kills a feed** (`lib/feedParser.js`): `media:content` arrives as object *or* array (`?.` doesn't short-circuit on arrays); handle both; per-item try/catch so one bad item drops the item, not the feed.
6. **Total failure blanks the feed** (`lib/feedParser.js:98`): return partial-failure metadata; on total transient failure respond with an error status so the client keeps showing existing headlines.

### 5.5 Supabase hygiene (from security advisor, 2026-07-11)

- Revoke `EXECUTE` on `public.handle_new_user()` from `anon` and `authenticated` (SECURITY DEFINER function currently callable via REST RPC).
- Enable leaked-password protection (relevant when email sign-in arrives in Phase 4; free to enable now).
- `allowed_users` RLS-with-no-policies is intentional (locked from the API); leave as-is.
- RLS itself verified correct this session: all user tables enforce `auth.uid() = user_id`.

### 5.6 Testing — the repo's first tests

Introduce **vitest** (+ jsdom where needed). Every fix gets a test that fails before / passes after:

- `urlGuard`: table of hostile URLs (loopback, private ranges, metadata IP, `file:`, `javascript:`, redirect-to-private) — all rejected; benign URLs pass.
- Sanitizer: XSS vector table (event handlers, `javascript:` hrefs, `<iframe>`, SVG script) — all neutralized.
- `feedParser`: `media:content` object/array/absent; one bad item doesn't drop the feed; total-failure metadata.
- `feedStore`: stale response discarded (sequence token).
- `signOut`: IndexedDB + localStorage + store state cleared.

Coverage targets the changed code this phase; the 80% repo-wide bar phases in with later work.

### 5.7 Verification (definition of done)

1. `npm run build` and `npx vitest run` — exit codes cited, no output filtering.
2. Manual smoke on the dev server: feed loads → article opens (sanitized) → sign-out clears data.
3. Supabase security advisors re-run: prior WARNs cleared.
4. **Post-deploy** (deploy is a separate fact from push): curl production endpoints — CSP header present, CORS narrowed, rate limit returns 429 on abuse, PWA/service worker still functional.

### 5.8 Explicitly out of scope for Phase 1

New features, UI changes, the 17 MEDIUMs and 6 critic gaps from the review (tracked for later phases; several — e.g. unbounded history growth, dead save-url subsystem — are absorbed into Phase 2's design), governance file scaffolding (offered separately).

## 6. Ruled out

- Server-side publisher credential storage / paywall scraping (legal exposure, credential custody, brittleness — Matter precedent).
- X/Threads ingestion in v1 (no free API).
- Native rewrite (React Native/Expo).
- Billing in the PWA phases.
- Big-bang launch (build everything, ship once).

## 7. Open items carried forward

- Phase 3 spec: inbound email provider choice (Cloudflare Email Routing vs Postmark/Mailgun), parsing pipeline, storage quotas.
- Phase 4 spec: beta cap mechanics, analytics tool, legal page templates.
- Monetization phase: Vercel plan review; store developer accounts; IAP pricing.
- Portfolio housekeeping (outside Masthead): audit the 6 Supabase Pro projects for zombies to cut the org bill.

## 8. Phase 1 success criteria

- All three CRITICAL attack paths demonstrably closed (tests + manual PoC checks).
- All six HIGH bugs fixed with regression tests.
- Zero visual/behavioral regression for a normal reader session.
- Advisors clean; build green; deployed artifact verified live.
