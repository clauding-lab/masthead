# Phase 2 · Slice 2E — Premium Subscriber Feeds

**Date:** 2026-07-18
**Depends on:** 2B (live-fetch pipeline + SSRF guards), 2C (auth + RLS-private library), 2D (kind model, Add Source modal) — all shipped.
**Unblocks:** Phase 2 completion (2E is the fifth and final slice). Phase 3 (email inbox) is independent.

---

## 1. Goal

Let a signed-in user register up to 5 secret-bearing subscriber feed URLs (e.g. The Verge subscriber full-text RSS, a paid Substack's private feed) that behave like first-class sources — appearing in News or Blogs by kind, readable in-app, saveable to their library — while the URL itself is held in server custody: transmitted once at add time, never displayed again, never readable by any client role, never persisted as content, and never able to leak into the public catalog, the shared store, logs, or error messages.

## 2. Scope decisions (owner Q&A, 2026-07-18)

| Question | Decision |
| --- | --- |
| Where do premium articles surface? | **By kind, with a lock badge** — user picks news/blog at add time (2D modal); articles appear in the News or Blogs tab like any source; the lock badge marks the source in Settings and source chips. No new surface. |
| Auth requirement | **Signed-in only.** Server custody, masking, and cross-device roaming all need an account. Signed-out users can still paste a premium URL as a plain custom source (existing behavior, their own risk, their own device). |
| Per-user cap | **5 feeds**, enforced server-side. Raisable later without migration. |
| Architecture | **Approach A — on-demand live fetch, zero storage of premium content.** Articles are fetched live per authenticated request through the existing custom-source pipeline and never written to any table. Rejected: per-user cron polling (cost scales with signups regardless of usage; persists paid content in our DB); server-side caching (named upgrade path, not built now). |
| URL lifecycle | **Write-only.** No reveal, no edit — delete and re-add. The last time the full URL is on screen is the input field the user typed it into. |

## 3. Data model

### 3.1 New table `user_premium_feeds` (the only DB change)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK, `gen_random_uuid()` | Doubles as the client-facing source id for premium headlines. |
| `user_id` | uuid NOT NULL → `auth.users` ON DELETE CASCADE | |
| `url` | text NOT NULL | **The secret.** CHECK: must match `^https://` (never plaintext HTTP). |
| `label` | text NOT NULL | Display name; defaults to the feed's own title captured at add-time validation; clamped. |
| `kind` | text NOT NULL CHECK IN (`news`,`blog`) | No premium social. |
| `category` | text NOT NULL | Same namespace as custom sources (2D §3.3); default `custom`. |
| `host_hint` | text NOT NULL | Derived server-side at insert: **hostname only** (e.g. `theverge.com`). Tokens live in paths and query strings — those are never stored anywhere the client can read, and never displayed. |
| `created_at` | timestamptz DEFAULT now() | |

Constraints: UNIQUE `(user_id, url)`; the 5-cap is enforced in the endpoint (and the migration may add a belt-and-braces trigger — plan decides).

### 3.2 Custody: service-role-only, zero client grants

`REVOKE ALL` from `anon`, `authenticated`, **and `PUBLIC`** (the revoke-PUBLIC gotcha — AGENT_LEARNINGS). RLS enabled with no permissive policies as defense in depth. The table is reachable **only** through the service-role key inside API routes; the `url` column never crosses PostgREST to a browser. This is deliberately stronger than 2C's RLS-owner-readable pattern: the owner cannot read their own secret back, by design.

Post-migration **probe verification** (2B/2C pattern): anon AND authenticated clients attempt SELECT/INSERT/UPDATE/DELETE and must get zero rows / errors.

## 4. Server changes

### 4.1 New route `api/premium-feeds.mjs` — the API's first authenticated endpoint

Every method requires a Supabase JWT in the `Authorization: Bearer` header, verified server-side (mechanism — `auth.getUser(token)` via the admin client or local JWKS verify — is a plan decision). No/invalid token → 401. Rate-limited per IP like sibling routes.

- **POST** `{ url, kind, label?, category? }` — add. Pipeline: https-only check → `urlGuard` SSRF validation (same guard as custom fetches, including redirect hops) → **live validation fetch** through the existing guarded parser (must parse as RSS/Atom within timeout; yields default label from feed title) → cap check (≤5) → dupe check → insert with derived `host_hint` → returns `{ id, label, kind, category, hostHint }`. **Never the URL.**
- **GET** — list the caller's feeds, masked: `{ id, label, kind, category, hostHint, createdAt }`.
- **DELETE** `{ id }` — delete own row only (`user_id` scoped).

`vercel.json` gains a `functions` entry for the route (`maxDuration: 30` — POST does one live fetch).

### 4.2 `/api/feeds` gains optional auth (premium rides the custom pipeline)

POST body gains optional `premiumIds: string[]`. When present **and** a valid `Authorization` token rides along, the server loads those rows via service role, **intersects with rows the caller owns**, resolves them into custom-source definitions (`{ id: row.id, name: label, feedUrl: url, category, kind }`), and appends them to the existing custom live-fetch set — same parser, same per-feed failure isolation, same merge-and-sort. Validation change: `sources` may now be an empty array when `premiumIds` is non-empty and authed.

- Premium headlines carry `sourceId = row.id`, `sourceName = label`, `isPremium: true`, and `content` (feed-provided body, sanitized server-side via the existing sanitize pass, clamped per item — clamp size is a plan decision).
- **Token invalid/expired → not silent:** the response returns without premium items plus `premiumAuthFailed: true`; the client refreshes the session and retries once, else surfaces a sign-in prompt.
- Unauthed/id-mismatched `premiumIds` resolve to nothing — no error oracle revealing whether an id exists.

### 4.3 Leak-proofing (binding rules, each backed by a test in §7)

1. The full URL appears in exactly one request ever: the add-time POST body over TLS.
2. No API response after add contains the URL — list, add-confirmation, and feed responses are asserted URL-free.
3. The URL never appears in a GET query string anywhere.
4. No log line or error message contains the URL: premium fetch/validation errors log **row id + host_hint only**. The parser error path is explicitly scrubbed before logging (parser errors embed the fetched URL today).
5. The cron, the shared `articles` store, `lib/sources.json`, and the public catalog are untouched — premium content and URLs never enter any of them.

## 5. Client changes

### 5.1 Add flow — `AddSourceModal`

A "Premium subscriber feed" checkbox with a one-line explainer ("URL contains your personal token — stored securely, never shown again"). Signed out + checked → inline sign-in prompt, no submit. Checked + submit → `POST /api/premium-feeds` (instead of creating a localStorage custom source); `suggestKind` still pre-picks news/blog; kind choice excludes social when checked. Success state shows the masked identity (`label · host_hint`) — the URL input is cleared and never echoed.

### 5.2 Settings & selection state

Premium feeds render inside their kind group with a **lock badge**, masked (`label · theverge.com`), with the same enable/disable toggle as other sources plus delete (with confirm; no edit). The masked list is fetched on sign-in/app load; it may be cached locally (contains no secrets). Toggle state lives client-side alongside other selections; enabled premium ids are sent as `premiumIds` on `/api/feeds` POSTs. Sign-out clears the cached masked list and any in-memory premium headlines (2C storage-sweep lesson applies to whatever keys this slice adds).

### 5.3 Feed surfaces & reader

Premium cards render like any card in News/Blogs (per-kind surfaces request their enabled premium ids of that kind; "All" in News includes enabled premium news feeds — they are user-chosen, unlike the social chip). **The reader prefers feed-provided content over the extractor:** for `isPremium` items the reader renders the sanitized `content` from the feed response directly — pointing `/api/extract` at a paywalled article URL would fetch the teaser. Items whose feed provides no body fall back to the extractor (some subscriber feeds are excerpt-only; the result is whatever the public page offers).

### 5.4 Save to library

Heart works. Saving a premium item stores its feed-provided body into the user's own RLS-private `user_saved_articles` — the user's private copy of content they paid for, same rationale as 2C. Nothing changes in the library schema; the save path already accepts a provided body.

## 6. Edge cases

| Case | Behavior |
| --- | --- |
| Publisher rejects the URL (token expired/revoked → 401/403/404) | Per-feed failure, isolated. Feed view shows an inline notice on the premium source distinguishing "publisher rejected — re-add the URL from your subscription page" from transient network errors. Never silent. |
| Feed goes permanently dead | Same inline notice; user deletes it. No auto-removal in 2E. |
| Same URL added twice | 409 from UNIQUE constraint, friendly message. |
| 6th feed | 403-with-reason from cap check. |
| `http://` URL | Rejected at POST with explicit "https required" message. |
| Redirecting feed URL | Followed within existing guard policy (urlGuard re-checks each hop); the token going where the publisher redirects is the publisher's design. |
| Signed out with premium feeds enabled | Client sends no `premiumIds`; premium sources shown in Settings only after sign-in. No spinner, no error. |
| Excerpt-only subscriber feed | Reader falls back to extractor (§5.3) and renders whatever the public page offers — possibly a teaser. Acceptable: a body is always rendered, so no error state is needed. |
| Account deleted | Rows cascade-delete with the user. |

## 7. Testing

- **Custody probes (post-migration, real project):** anon + authenticated SELECT/INSERT/UPDATE/DELETE against `user_premium_feeds` all fail / return zero rows.
- **Endpoint auth:** no token → 401 on all methods; valid token cannot list/delete another user's rows; foreign/unknown `premiumIds` on `/api/feeds` resolve to nothing without an error oracle.
- **Add pipeline:** https-only rejection; SSRF rejection (private-IP URL); non-feed URL rejection; cap (6th → 403); dupe (409); label default from feed title; `host_hint` = hostname only.
- **Leak sweep:** assert the URL string absent from every response body of list/add/feeds; assert scrubbed logging on forced parser failure (error path contains row id + host, not the URL or its path/query).
- **feedService merge:** premium defs join the custom set; per-feed failure isolation; `premiumAuthFailed` flag on bad token; empty-`sources`+`premiumIds` request validates.
- **Reader preference:** `isPremium` item with content renders it (sanitized), no extract call; content-less premium item falls back to extract.
- **Real-fixture rule (AGENTS landmine 15):** parser/content tests use a real captured full-content RSS fixture, not hand-built XML.
- **Client:** modal premium path (signed-out prompt, no social kind, no URL echo after success); Settings lock badge + masked display + delete; sign-out sweep of premium keys.
- **Live drive (prod):** register a real full-text RSS feed as premium (a full-content Substack feed serves as the stand-in token-bearer), see cards in the right tab, open reader (feed content, no extract), heart it, verify masked Settings display, delete it. Screenshot evidence per house practice.

## 8. Out of scope

Per-user polling or server-side caching (Approach C is the named upgrade path if live-fetch latency hurts); offline premium reading; premium social kind; URL reveal or edit; OPML import; auto-disable of dead feeds; email ingestion (Phase 3); any change to the cron, the shared store, or the public catalog.

## 9. Rollout & proof-of-done

1. Migration applied + custody probes pass (recorded output).
2. Full gates: `npm test` exit 0 (count reported vs 194 baseline), `npm run build` exit 0, eslint at recorded baseline (4 errors + 5 warnings), zero new.
3. Live drive per §7 on masthead-news.vercel.app with screenshots.
4. Leak sweep re-run against prod responses (list + feeds) for the drive account.
5. PR → checks → owner-gated merge (house /ship flow).

## 10. Review log

- 2026-07-18 owner Q&A: surfacing (by kind + lock badge), signed-in only, cap 5, Approach A — recorded in §2. Spec red-team: owner call pending at spec review.
