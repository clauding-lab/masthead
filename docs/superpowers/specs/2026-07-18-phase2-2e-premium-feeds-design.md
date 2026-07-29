# Phase 2 · Slice 2E — Premium Subscriber Feeds

**Date:** 2026-07-18 (red-team amendments 2026-07-19)
**Depends on:** 2B (live-fetch pipeline + SSRF guards), 2C (auth + RLS-private library), 2D (kind model, Add Source modal) — all shipped.
**Unblocks:** Phase 2 completion (2E is the fifth and final slice). Phase 3 (email inbox) is independent.

---

## 1. Goal

Let a signed-in user register up to 5 secret-bearing subscriber feed URLs (e.g. The Verge subscriber full-text RSS, a paid Substack's private feed) that behave like first-class sources — appearing in News or Blogs by kind, readable in-app, saveable to their library — while the secret is held in server custody: transmitted at add time only, never displayed again, never readable by any client role, and never able to leak into the public catalog, the shared store, logs, error messages, **or back out through the feed's own item links and article bodies** (subscriber feeds routinely re-embed the same token there — §4.3 rule 1 covers this second copy).

## 2. Scope decisions (owner Q&A, 2026-07-18/19)

| Question | Decision |
| --- | --- |
| Where do premium articles surface? | **By kind, with a lock badge** — user picks news/blog at add time (2D modal); articles appear in the News or Blogs tab like any source; the lock badge marks the source in Settings and source chips. No new surface. |
| Auth requirement | **Signed-in only.** Server custody, masking, and cross-device roaming all need an account. Signed-out users can still paste a premium URL as a plain custom source (existing behavior, their own risk, their own device). |
| Per-user cap | **5 feeds**, enforced at the DB level (§3.1). Raisable later without migration. |
| Architecture | **Approach A — on-demand live fetch, zero storage of premium content.** Articles are fetched live per authenticated request and never written to any table. Rejected: per-user cron polling (cost scales with signups regardless of usage; persists paid content in our DB). A short **server-side TTL cache** (§4.2) IS in scope — it doubles as publisher-politeness throttling. |
| URL lifecycle | **Write-only with metadata edit.** No reveal of the URL; label/kind/category are editable via PATCH (§4.1) so a typo never forces re-sending the secret; changing the URL itself = delete and re-add. |
| Bearer-credential residual risk | **Accepted (owner, 2026-07-19).** The URL is a bearer credential: possession, not subscription ownership, is the only test — several accounts can register the same URL and we cannot detect rightful ownership. Mitigation is a one-line warning in the Add flow ("this link works like a password for your subscription"); no enforcement or abuse-monitoring machinery (owner declined). Documented here per the `lib/urlGuard.js` accepted-residual-risk precedent. |
| Saving paid content to the library | **Accepted (owner, 2026-07-19).** Hearting a premium item keeps a durable private copy of paid content in `user_saved_articles` (tombstone-delete semantics as any save) — the user's own copy of content they paid for. A deliberate product decision, not an inherited 2C default. |
| Spec red-team | **Ran 2026-07-19** (4 lenses, 2-skeptic verification, all Sonnet 5 per owner directive): 24 raw → 21 surviving findings, all 21 amendments applied to this revision. See §10. |

## 3. Data model

### 3.1 New table `user_premium_feeds` (the only DB change)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK, `gen_random_uuid()` | Doubles as the client-facing source id for premium headlines. |
| `user_id` | uuid NOT NULL → `auth.users` ON DELETE CASCADE | |
| `url` | text NOT NULL | **The secret.** CHECK: must match `^https://` (never plaintext HTTP). |
| `label` | text NOT NULL | Display name; defaults to the feed's own title captured at add-time validation; clamped; editable via PATCH. |
| `kind` | text NOT NULL CHECK IN (`news`,`blog`) | No premium social. Editable via PATCH. |
| `category` | text NOT NULL | Same namespace as custom sources (2D §3.3); default `custom`. Editable via PATCH. |
| `host_hint` | text NOT NULL | Derived server-side at insert from the **post-redirect resolved URL** of the validation fetch, reduced to the **registrable domain** (eTLD+1, e.g. `theverge.com` — some feed schemes put reader-identifying tokens in subdomain labels; PSL mechanism or documented fallback is a plan decision). Never the path or query. |
| `created_at` | timestamptz DEFAULT now() | |

Constraints: UNIQUE `(user_id, url)`. **The 5-cap is enforced by the database** — a BEFORE INSERT trigger (or equivalent atomic in-transaction check) so the 5th-vs-6th decision is made by Postgres, not by two API round-trips (check-then-insert is a TOCTOU race). The endpoint still pre-checks for a friendly error, but the trigger is the enforcement. §7 requires a concurrent-insert test: N parallel adds for one user → exactly 5 succeed.

### 3.2 Custody: service-role-only, zero client grants

`REVOKE ALL` from `anon`, `authenticated`, **and `PUBLIC`** (the revoke-PUBLIC gotcha — AGENT_LEARNINGS). RLS enabled with no permissive policies as defense in depth. The table is reachable **only** through the service-role key inside API routes; the `url` column never crosses PostgREST to a browser. This is deliberately stronger than 2C's RLS-owner-readable pattern: the owner cannot read their own secret back, by design.

Post-migration **probe verification** (2B/2C pattern): anon AND authenticated clients attempt SELECT/INSERT/UPDATE/DELETE and must get zero rows / errors.

## 4. Server changes

### 4.1 New route `api/premium-feeds.mjs` — the API's first authenticated endpoint

Every method requires a Supabase JWT in the `Authorization: Bearer` header, verified server-side in **one shared `lib/` module** (mechanism — `auth.getUser(token)` via the admin client or local JWKS verify — is a plan decision) so no route reimplements it differently. **Binding fail-closed rule: any failure of the verification step itself — network error to Supabase Auth, JWKS fetch failure, timeout, malformed token, any thrown exception — resolves to 401, never to an authenticated fallback.** This explicitly does NOT inherit the fail-open posture of `lib/rateLimit.js`; that pattern is for abuse-mitigation availability, not identity. §7 requires a test that forces the verifier to throw and asserts 401.

- **POST** (add) `{ url, kind, label?, category? }` — pipeline **in this order, cheap checks before any network**: https-only → cap pre-check (indexed count) → dupe check (exact URL for this user) → `urlGuard` SSRF validation → **live validation fetch** through the existing guarded parser (must parse as RSS/Atom within timeout; yields default label from feed title and the post-redirect resolved URL for `host_hint`) → insert (DB trigger backstops the cap). Returns `{ id, label, kind, category, hostHint }` — never the URL. **Anti-oracle rule:** every validation failure returns one generic message/status regardless of cause (SSRF-blocked, DNS failure, timeout, publisher 401/403/404, non-feed content) — this is the one place a signed-in caller can point our server at any HTTPS URL, and it must not become a probe for whether a guessed token is live. Detail goes to server logs keyed by host only. The §6 "publisher rejected — re-add" UX applies only to later fetches of feeds the caller already owns, never to the add response.
- **GET** — list the caller's feeds, masked: `{ id, label, kind, category, hostHint, createdAt }`.
- **GET (body-on-demand)** `?feed=<id>&article=<articleId>` — returns one article's sanitized, token-redacted full body for the reader (§5.3), served from the TTL cache (§4.2) or a fresh guarded fetch of the caller's own feed. Same route file — no extra function entry.
- **PATCH** `{ id, label?, kind?, category? }` — metadata only, **never `url`**; own rows only.
- **DELETE** `{ id }` — own rows only.

Rate limits: **tighter than sibling routes and keyed per-account as well as per-IP** (POST tightest — it triggers outbound fetches; exact numbers are a plan decision). `vercel.json` gains a `functions` entry (`maxDuration: 30`).

### 4.2 `/api/feeds` gains optional auth (premium rides the custom pipeline)

POST body gains optional `premiumIds: string[]` (**array length capped at 10** before any DB work). When present **and** a valid token rides along (same shared verifier, same fail-closed rule), the server loads those rows via service role, **intersects with rows the caller owns**, resolves them into custom-source definitions, and appends them to the existing custom live-fetch set — same parser, same per-feed failure isolation, same merge-and-sort. Validation change: `sources` may now be an empty array when `premiumIds` is non-empty and authed.

- **TTL single-flight cache, per feed row (60–120s, plan picks):** mirrors the existing `liveFallback` pattern. Repeated loads within the window — tab switches, category changes, pull-to-refresh — reuse the last live result instead of re-hitting the publisher. This is also our publisher-politeness throttle: a paid subscriber feed is a different traffic class from public RSS, and our own UI cadence must never look like abuse to the publisher's systems. The body-on-demand endpoint (§4.1) reads through the same cache.
- **3-second per-premium-feed timeout** (shorter than the general pipeline's): one hanging premium feed must not stall the whole response — catalog headlines arrive from a millisecond DB read and must not wait 6+ seconds for a dead publisher. Progressive client-side rendering of premium items is the named upgrade path if 3s still hurts.
- **Premium headlines carry excerpt only — never full `content`** (5 feeds × 15 full bodies would put multiple MB on every load for bodies the list UI never renders). Fields: `sourceId = row.id`, `sourceName = label`, `isPremium: true`, `hasBody: boolean` (whether the feed item included a full body — drives the reader's §5.3 choice), plus the standard card fields with the item URL **token-redacted** per §4.3 rule 1.
- A per-user rate limit applies to premiumIds-bearing requests (plan sets numbers) — the route's existing 60/min/IP limit was sized for text reads, not fan-out live fetches.
- **Token invalid/expired → not silent:** the response returns without premium items plus `premiumAuthFailed: true`; the client refreshes the session and retries once, else surfaces a sign-in prompt.
- Unauthed/id-mismatched `premiumIds` resolve to nothing — no error oracle revealing whether an id exists.

### 4.3 Leak-proofing (binding rules, each backed by a test in §7)

1. **The secret must never appear in any response — including inside feed-derived data.** Subscriber feeds routinely stamp the same token onto every item's `<link>` and into personalized manage-subscription/unsubscribe links in article bodies. A server-side **token-redaction pass** runs over every premium item's URL and (for body-on-demand) its content links before anything reaches a client: any occurrence of the registered feed URL's secret components (query-parameter values and high-entropy path segments; exact heuristics are a plan decision) is stripped or the link neutralized. The §7 leak sweep asserts the secret's substrings absent from **every** response body. Because redaction happens server-side, everything downstream — reader, share button, saved library rows — inherits clean URLs and content with no client-side discipline required.
2. The full URL appears on the wire only in the add-time POST body over TLS (once per add-or-replace).
3. The URL never appears in a GET query string anywhere.
4. No log line or error message contains the URL: premium fetch/validation errors log **row id + host_hint only**. The parser error path is explicitly scrubbed before logging (parser errors embed the fetched URL today).
5. **No request-body capture on this route:** the add-time POST body is the one legitimate carrier of the secret. Verified: no APM/error-tracking tooling captures request bodies today; none may be added to this route without explicit body-scrubbing, and Vercel platform request logging does not log bodies. Recorded as a standing constraint.
6. The cron, the shared `articles` store, `lib/sources.json`, and the public catalog are untouched — premium content and URLs never enter any of them.

## 5. Client changes

### 5.1 Add flow — `AddSourceModal`

A "Premium subscriber feed" checkbox with a two-line explainer: "URL contains your personal token — stored securely, never shown again. **Treat this link like a password: anyone who has it can read your paid content.**" Signed out + checked → inline sign-in prompt, no submit. Checked + submit → `POST /api/premium-feeds` (instead of creating a localStorage custom source); `suggestKind` still pre-picks news/blog; kind choice excludes social when checked. **Autofill hardening (binding):** while premium mode is checked, the URL input carries `autoComplete="off"` plus a per-mount randomized `name`/`id` (major browsers ignore bare `autocomplete="off"` on visible fields and would otherwise retain the secret in the browser's own form-history — outside our custody entirely). §7 has a client test asserting the attributes. Success state shows the masked identity (`label · host_hint`); the input is cleared and never echoed.

### 5.2 Settings, selection state, and the client architecture

**New client plumbing (the existing pipeline structurally cannot carry premium ids):**
- A `premiumFeeds` state slice (settingsStore or a dedicated store) holding the masked GET list with `kind`, plus a `getEnabledPremiumIdsByKind(kind)` selector mirroring `getEffectiveSourcesByKind`.
- The per-surface request selectors (`selectRequest` for the news/blogs store instances) additionally return the surface's enabled, kind-filtered `premiumIds`; `fetchHeadlinesWithSources` carries `premiumIds` and the `Authorization: Bearer` header through to `/api/feeds`.
- **Landmine 16 amendment (deliberate, test-backed):** the no-network-on-empty guard in `feedStore.fetchFeeds()` becomes "skip only when `sources` is empty **and** `premiumIds` is empty" — otherwise a premium-only surface would never fetch at all. `feedStore.test.js` gains the "zero regular sources, non-zero premium ids still fetches" case alongside the existing no-network cases, so the invariant and the feature can't silently regress each other. AGENTS.md landmine 16 gets the same one-line amendment at ship time.

**Reconciliation (the landmine-17 healing pattern, applied to premium):** on every fetch of the masked list — sign-in, app load, and opening Settings' premium section — local enabled-ids are reconciled against server truth: ids no longer present are dropped (a feed deleted on device A stops being silently sent forever by device B), and server-side ids absent from local selection default to **enabled** (a feed the user explicitly paid to set up must not be invisible on a new device).

**Display:** premium feeds render inside their kind group with a **lock badge**, masked (`label · theverge.com`), with the same enable/disable toggle as other sources, PATCH-backed edit for label/kind/category, and delete (with confirm). The masked list may be cached locally (contains no secrets).

**Sign-out sweep (2C lesson, extended to every cache this slice touches):** `signOut()` must (a) clear the cached masked list and any premium keys, (b) **reset the news and blogs feed-store instances** (headlines/fetchedAt/error — in-memory Zustand state is invisible to the localStorage prefix sweep), and (c) **delete the service worker's `api-cache`** (the pre-existing blanket Workbox `GET /api/*` runtime cache would otherwise hand the masked premium list to the next account on a shared device). §7 tests all three.

### 5.3 Feed surfaces & reader

Premium cards render like any card in News/Blogs (per-kind surfaces request their enabled premium ids of that kind; "All" in News includes enabled premium news feeds — they are user-chosen, unlike the social chip). **Reader:** for `isPremium` items with `hasBody`, the reader calls the body-on-demand endpoint (§4.1) and renders the sanitized, token-redacted body — never `/api/extract`, which would hit the paywall and fetch the teaser. `hasBody: false` (excerpt-only subscriber feeds) falls back to the extractor; the result is whatever the public page offers. **Redirect drift:** if a later fetch resolves to a different registrable domain than `host_hint`, the feed is treated as failed with the §6 inline notice — never a silent content swap from a host the user never approved.

### 5.4 Save to library

Heart works. Saving a premium item fetches its body via the body-on-demand endpoint (if not already open in the reader) and stores it into the user's own RLS-private `user_saved_articles`. **Owner sign-off (2026-07-19, §2):** this is a deliberate decision to retain paid content as the user's private copy — with the mitigation that everything stored has already passed the §4.3 token-redaction pass, so the saved `url`/`content` carry no secret. Nothing changes in the library schema.

## 6. Edge cases

| Case | Behavior |
| --- | --- |
| Publisher rejects the URL on a periodic fetch (token expired/revoked → 401/403/404) | Per-feed failure, isolated. Feed view shows an inline notice on the premium source distinguishing "publisher rejected — re-add the URL from your subscription page" from transient network errors. Never silent. Applies only to owned feeds — never the add-time response (§4.1 anti-oracle). |
| Feed resolves to a different registrable domain than at add time | Treated as the row above — inline notice, no content rendered (§5.3). |
| Feed goes permanently dead | Same inline notice; user deletes it. No auto-removal in 2E. |
| Same URL added twice | 409 from UNIQUE constraint, friendly message. |
| 6th feed (including concurrent adds) | Rejected by the DB trigger; endpoint returns 403-with-reason. |
| `http://` URL | Rejected at POST with explicit "https required" message (the one non-generic add error — it leaks nothing about a remote host). |
| Slow premium feed | 3s premium timeout (§4.2); its items are absent this round, feedStats reflect the failure, everything else renders on time. |
| Redirecting feed URL | Followed within existing guard policy (urlGuard re-checks each hop); `host_hint` reflects the post-redirect resolved URL at add time. |
| Signed out with premium feeds enabled | Client sends no `premiumIds`; premium sources shown in Settings only after sign-in. No spinner, no error. |
| Excerpt-only subscriber feed (`hasBody: false`) | Reader falls back to extractor and renders whatever the public page offers — possibly a teaser. Acceptable: a body is always rendered, so no error state is needed. |
| Feed deleted on another device | Reconciliation (§5.2) drops the dead id on next masked-list fetch; until then the server resolves it to nothing, silently by design. |
| Account deleted | Rows cascade-delete with the user. |

## 7. Testing

- **Custody probes (post-migration, real project):** anon + authenticated SELECT/INSERT/UPDATE/DELETE against `user_premium_feeds` all fail / return zero rows.
- **Endpoint auth:** no token → 401 on all methods; **forced verifier throw → 401** (fail-closed rule); valid token cannot read/PATCH/DELETE another user's rows; foreign/unknown `premiumIds` resolve to nothing without an error oracle.
- **Add pipeline:** order verified cheap-before-network (capped-out user and dupe URL never trigger a fetch); https-only rejection; SSRF rejection; non-feed rejection; **generic add-failure response identical across SSRF/DNS/timeout/publisher-401/non-feed causes**; label default from feed title; `host_hint` = registrable domain of post-redirect URL.
- **Cap:** N concurrent inserts for one user → exactly 5 rows (DB-level test).
- **Leak sweep:** the registered secret's substrings (query values, token path segments) asserted absent from every response body — list, add, PATCH, feeds, **and body-on-demand content/links** (token-redaction pass); scrubbed logging on forced parser failure (row id + host, never the URL).
- **feedService merge:** premium defs join the custom set; per-feed isolation; 3s premium timeout (hanging feed → response returns without it, on time); TTL cache single-flights repeat requests within the window; `premiumAuthFailed` on bad token; empty-`sources`+`premiumIds` validates; `premiumIds` array length cap.
- **Reader:** `hasBody` item → body-on-demand endpoint, no extract call; `hasBody: false` → extractor fallback; redirect-drift → inline notice, no render.
- **Real-fixture rule (AGENTS landmine 15):** parser/content/redaction tests use a real captured full-content RSS fixture **whose item links and body carry the feed token**, not hand-built XML.
- **Client:** modal premium path (signed-out prompt, no social kind, no URL echo, **autofill attributes present in premium mode**); Settings lock badge + masked display + PATCH edit + delete; **feedStore guard: zero sources + non-zero premiumIds still fetches; zero + zero still doesn't** (landmine 16 both ways); reconciliation (dead ids dropped, new server ids default enabled); **sign-out: masked list cleared, both feed stores reset, service-worker `api-cache` deleted**.
- **Live drive (prod):** register a real full-text RSS feed as premium (a full-content Substack feed serves as the stand-in token-bearer), see cards in the right tab, open reader (body-on-demand, no extract), heart it, verify masked Settings display + PATCH edit, delete it, verify reconciliation. Screenshot evidence per house practice.

## 8. Out of scope

Per-user cron polling; progressive client-side rendering of premium items (named upgrade path if the 3s timeout still hurts); offline premium reading; premium social kind; URL reveal or URL edit; OPML import; auto-disable of dead feeds; abuse-signal monitoring for shared bearer URLs (owner declined, §2); email ingestion (Phase 3); any change to the cron, the shared store, or the public catalog.

## 9. Rollout & proof-of-done

1. Migration applied + custody probes pass (recorded output).
2. Full gates: `npm test` exit 0 (count reported vs 194 baseline), `npm run build` exit 0, eslint at recorded baseline (4 errors + 5 warnings), zero new.
3. Live drive per §7 on masthead-news.vercel.app with screenshots.
4. Leak sweep re-run against prod responses (list + feeds + body-on-demand) for the drive account, asserting the real registered token absent.
5. AGENTS.md landmine 16 amended in the same PR (§5.2).
6. PR → checks → owner-gated merge (house /ship flow).

## 10. Review log

- 2026-07-18 owner Q&A: surfacing (by kind + lock badge), signed-in only, cap 5, Approach A — §2.
- 2026-07-19 **spec red-team** (owner-approved gate; 4 adversarial lenses × 2-skeptic verification, 52 agents, all Sonnet 5 per owner directive): 24 raw findings → 14 CONFIRMED + 7 PLAUSIBLE survivors, 3 killed. All 21 amendments applied in this revision — headline items: token-redaction rule (§4.3.1), fail-closed auth (§4.1), DB-level cap + reordered add pipeline (§3.1/§4.1), landmine-16 guard amendment + client plumbing (§5.2), sign-out sweep extension incl. service-worker cache (§5.2), TTL cache + 3s timeout + excerpt-only list payload with body-on-demand (§4.2), add-time anti-oracle (§4.1), autofill hardening + bearer warning (§5.1), PATCH metadata (§4.1), reconciliation (§5.2), host_hint registrable-domain + redirect drift (§3.1/§5.3).
- 2026-07-19 owner calls: apply all 21; library retention accepted; bearer-credential residual risk accepted with add-flow warning, no monitoring.
