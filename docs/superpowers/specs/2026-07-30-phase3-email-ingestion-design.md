# Phase 3 — Email Ingestion (Newsletter Inbox)

**Date:** 2026-07-30 (spec red-team amendments 2026-07-31)
**Depends on:** Phase 2 complete — 2B (server store + cron plumbing patterns), 2C (auth, RLS-private user tables, tombstone deletes), 2D (kind model, tab surfaces), 2E (authed API pattern `lib/authVerify.js`, body-on-demand reader mode, custody probes, DB-level cap-trigger pattern).
**Unblocks:** Phase 4 (Launch) — the inbox is the future paid differentiator (Meco/Readwise Reader precedent, master spec §1).

---

## 1. Goal

Give every signed-in user a private ingest email address (`<slug>@masthead.clauding-lab.com`). Newsletters delivered there — free or the user's own paid subscriptions — land in a dedicated **Inbox** tab as clean, sanitised reading views. Zero monthly infrastructure cost (Cloudflare Email Routing free tier), bounded storage from day one, and two binding postures the red-team forced into first-class rules: **inbound mail never destroys stored user data** (no prune-on-ingest, ever), and **no failure mode may silently bounce a legitimate sender into unsubscribing the user**.

## 2. Scope decisions (owner Q&A 2026-07-30; autonomous decisions under the approved batch 2026-07-31, disclosed in §12)

| Question | Decision |
| --- | --- |
| Ingest domain | **`masthead.clauding-lab.com`** — Email Routing's subdomain feature on the existing Cloudflare zone, $0. Owner's first pick (`masthead.clauding.com`) was discovered to be a third party's domain and corrected. The apex's iCloud Mail MX records are load-bearing personal infrastructure — **binding rule: nothing this phase touches apex DNS** (§8.1). Decision rule if Cloudflare's subdomain flow turns out to require apex MX changes (unverifiable from docs alone; checked first, §10.2): fall back to buying `masthead.email` (~$10/yr, availability confirmed 2026-07-30) — the domain lives in config either way. |
| Inbound provider | **Cloudflare Email Routing + Email Worker** (free, 25 MiB inbound cap, catch-all → Worker). Rejected: parse-in-Worker (splits custody across deploy surfaces, service-role key in Cloudflare, escapes the vitest harness); paid inbound ESPs ($15–35/mo against a $0 product). |
| Where messages surface | **Dedicated Inbox tab.** Private pushed email never mixes with public RSS surfaces. |
| Execution mode | **Full autonomous batch (2E pattern):** build/test/merge per slice on green gates; owner-gated steps (Cloudflare token + subdomain/Worker config, migration DDL, ingest secret env) handed over prepared, batched, once per slice. |
| New dependency | **`postal-mime`** (zero-dep MIME parser, runs in Node) — sign-off batched into this spec's approval. |
| Addresses per user | **One**, created lazily, regeneratable. The address row is created once and **never deleted** while the account lives (§4.1) — "remove address" disables the slug, it does not drop state. No vanity slugs. |
| Heart-to-library identity | **Minted in-app permalink** (red-team survivor №1/№9): a hearted message saves under `https://<APP_ORIGIN>/inbox/message/<uuid>` — deterministic, never sender-derived — so saves roam through the existing cloud library and the CHECK/`isCloudSyncable` gates pass. Rejected: device-only saves (silent loss vs 2C's "saved things roam" expectation); sender-derived URLs (reopens landmine 18 server-side fetches of sender-chosen URLs). |
| Quota breach posture | **Defer, never destroy** (red-team survivors №3/№6): over-quota mail is deferred (sender retries) with a **7-day grace**, then bounced honestly. No prune-on-ingest. The user frees space themselves (delete, bulk "clear read"), which takes effect instantly (§6). |
| Remote images | **Blocked by default, per-message "Load images"** (red-team: every open is otherwise a read receipt; the ≤2px heuristic alone is false comfort). Settings gains a global "always load images" opt-in. |

## 3. Architecture

```
newsletter sender
      │  SMTP
      ▼
Cloudflare Email Routing (subdomain masthead.clauding-lab.com, catch-all rule)
      │  Email Worker `masthead-email-ingest` (dumb forwarder, in-repo email-worker/)
      │  POST raw MIME + envelope headers, x-ingest-secret auth
      ▼
POST /api/inbox-ingest  (Vercel fn; mirrored in server.js dev — landmine 1)
      │  secret → recipient lookup → rate limit → dedupe → postal-mime parse
      │  → sanitise (lib/sanitizeEmail.js) → quota gate (DB trigger enforced) → insert
      ▼
user_inbox_messages (service-role insert; RLS owner-read; owner tombstones directly)
      ▲                                    ▲
      │ supabase-js RLS reads              │ read_at / deleted_at updates (own rows)
      └────────── Inbox tab (client) ──────┘
```

**SMTP response mapping (binding — mail is never silently lost, and a transient outage never bounces):**

| API verdict | Worker action | Sender sees |
| --- | --- | --- |
| 2xx accepted / duplicate | accept | delivered |
| 404 unknown recipient · 413 oversize · 422 permanently unparseable MIME · over-quota **beyond the 7-day grace** | `setReject(reason)` | permanent bounce (NDR) |
| over-quota within grace · 429 rate-limited · 401 (our misconfig) · 5xx · network error | throw → transient failure | sender retries on its normal schedule (the retry window IS the user's grace period) |

**Verdict authentication (red-team ops):** the Worker treats a response as OUR verdict only when it carries the `x-masthead-ingest: 1` response header and a JSON `{ code }` body. A bare platform 404 (route rolled back), a WAF page, or any foreign response → transient, never a bounce. Cloudflare's throw-retry semantics are verified against current docs/behaviour in the plan before the catch-all is activated (§10.2); the Worker performs no parsing (streams bytes), so free-plan Worker CPU limits are not in play.

## 4. Data model (one migration batch, owner-run per landmine 14)

### 4.1 `user_ingest_addresses` — one row per user, for the life of the account

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK `gen_random_uuid()` | |
| `user_id` | uuid NOT NULL UNIQUE → `auth.users` ON DELETE CASCADE | The ONLY thing that deletes this row is account deletion. |
| `slug` | text UNIQUE NULL, CHECK (NULL or format regex) | `word-word-hex4` (~200-word curated list × 4 hex ≈ 2.6B). NULL = no active address (ingest 404s). "Remove" = `slug = NULL`; regenerate = UPDATE in place. Row-preserving verbs mean quota state and rate-limit identity can never be reset by address churn (red-team survivors №2/№8). |
| `over_quota_since` | timestamptz NULL | Set when an ingest first defers on quota; cleared when one succeeds. Drives the 7-day grace and the §7 "inbox full" state. |
| `deferred_count` / `last_deferred_at` | bigint / timestamptz | Metadata only (no bodies): lets the app tell the user what they're missing — in-app is the only channel that exists (§11: no sending). |
| `created_at` | timestamptz DEFAULT now() | |

**No `bytes_used` column.** Byte quota is **derived**: `sum(size_bytes) WHERE user_id = $1 AND deleted_at IS NULL` — an aggregate over ≤500 small ints on a partial index. A derived quota cannot drift, cannot go negative, cannot be reset by row churn, and makes the user's own tombstone free quota instantly with zero server code (red-team survivors №4/№7/№8).

**Custody: service-role only.** `REVOKE ALL` from `anon`, `authenticated`, `PUBLIC` (landmines 5+12); RLS on, zero policies. All access via `api/inbox-address`.

### 4.2 `user_inbox_messages`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK `gen_random_uuid()` | Also the permalink identity (§7.3). |
| `user_id` | uuid NOT NULL → `auth.users` ON DELETE CASCADE | |
| `from_email` / `from_name` | text NOT NULL / text | Clamped 320/200. |
| `subject` | text NOT NULL DEFAULT '' | Clamped 500; control chars stripped. |
| `html_body` / `text_body` | text | Sanitised server-side; NUL bytes stripped (Postgres rejects them). |
| `excerpt` | text | Derived ~200 chars; list view never ships bodies. |
| `size_bytes` | integer NOT NULL | UTF-8 octets of `html_body` + `text_body`, computed ONCE at ingest by the single byte helper (§5.1). Postgres `length()` is characters, not bytes — no SQL site may derive a byte figure from a body column (new AGENTS.md landmine, §10.5). |
| `web_url` | text NULL | Sender's canonical web copy (List-Post / "View in browser"), `https:` only, ≤4000 chars, else NULL. **Display-only** ("View original" link-out). Never the saved record's identity, never fetched server-side (§8.4). |
| `unsubscribe_url` | text NULL | From List-Unsubscribe: first `https:` URL, else first `mailto:`; else NULL. |
| `auth_results` | text NULL | Authentication-Results summary forwarded by the Worker if Cloudflare provides it (plan verifies); NULL otherwise. Drives a subtle "unverified sender" marker. |
| `dedupe_key` | text NOT NULL | Message-ID when present, else sha256 over (from_email, subject, Date header, body hash) — retries dedupe even without a Message-ID. UNIQUE `(user_id, dedupe_key)`. |
| `message_id` / `received_at` / `read_at` / `deleted_at` | text / timestamptz ×3 | `received_at` = server clock at ingest (Date header untrusted). `read_at` NULL = unread. `deleted_at` = tombstone; values in the future are treated as now() by the purge. |

Indexes: `(user_id, received_at DESC) WHERE deleted_at IS NULL`; unread partial for the badge count.

**Quota enforcement is in Postgres, not the app** (2E's TOCTOU lesson, red-team survivor №5): a BEFORE INSERT trigger — the `user_premium_feeds` cap-trigger pattern verbatim, per-user advisory xact lock — rejects the insert when live rows ≥ 500 or `sum(size_bytes)` would exceed 100 MB. The route pre-checks for a friendly verdict; the trigger is the enforcement. **Un-delete is forbidden at the DB level** (Task-1 review catch, 2026-07-31): the `deleted_at` column grant would otherwise let a client resurrect tombstoned rows past the quota (tombstone 400 → ingest 400 → un-delete = 880 live rows, app-free bypass); since the product has no restore feature, a BEFORE UPDATE trigger raises on any NOT NULL → NULL transition of `deleted_at`. Trigger function custody: `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`, verified via `has_function_privilege` (landmine 5).

**Custody:** landmine-12 revoke-then-grant, then `authenticated` gets `SELECT` + column-scoped `UPDATE (read_at, deleted_at)` with RLS `user_id = auth.uid()` (USING + WITH CHECK). No client INSERT/DELETE: the service role inserts, the purge cron hard-deletes. Mark-read, tombstone, and bulk "clear read" are direct supabase-js writes under the user's JWT (2C pattern) — and because quota is derived over live rows, deleting mail frees quota the same instant.

## 5. Server changes

### 5.1 `api/inbox-ingest.mjs`

POST only; no CORS grant (server-to-server; the secret, not CORS, is the gate). Auth: `x-ingest-secret` vs `INGEST_SECRET` env — constant-time compare in new `lib/ingestAuth.js` (cronAuth pattern), **fail-closed 401**; accepts `INGEST_SECRET_PREV` too, so rotation is zero-downtime. Raw body read as a stream with a 10 MB octet cap (413 beyond); raw-MIME body handling on Vercel (bodyParser opt-out) is a pinned plan task with a test.

Pipeline, cheap-before-expensive: secret → envelope `x-envelope-to` → local-part normalise (lowercase, strip `+suffix`) → slug lookup (service role; unknown/disabled → 404) → rate limits: per-user `inbox:<user_id>` 60/hr **plus** a global `inbox:global` ceiling and an unknown-recipient counter (red-team: per-slug keys alone meter nothing an attacker cares about) → `dedupe_key` computed and checked (**before** any quota work — a retry of a stored message must never 507) → `postal-mime` parse (attachments discarded; deterministically unparseable → 422 permanent) → sanitise via `lib/sanitizeEmail.js` (§8.3) → post-sanitise size ≤ 2 MB octets else 413 → insert via service role (trigger enforces quotas atomically; ON CONFLICT on dedupe_key → 200 duplicate) → verdict. **The ingest path issues INSERT only — it never updates or deletes an existing row** (binding; red-team survivor №6's test pins it). Every response carries `x-masthead-ingest: 1` + JSON `{ code }` (§3).

**The single byte helper:** `lib/inboxSize.js#messageBytes(html, text)` (`Buffer.byteLength`, UTF-8) is the only producer of a byte figure in Phase 3 — it feeds `size_bytes`, the 2 MB gate, and (via `sum(size_bytes)`) the quota trigger and the Settings meter (red-team survivor №7).

On quota rejection: set `over_quota_since` if NULL, bump `deferred_count`/`last_deferred_at`; within 7 days of `over_quota_since` → transient verdict; beyond → permanent. Any successful insert clears `over_quota_since`.

### 5.2 `api/inbox-address.mjs`

Authed via `lib/authVerify.js` (fail-closed). Row-preserving verbs only (§4.1): `GET` → `{ address|null, bytesUsed, messageCount, overQuotaSince, deferredCount }` (meter + full-state data; `bytesUsed` is the live derived sum, so it drops the instant mail is deleted); `POST` → `INSERT … ON CONFLICT (user_id) DO UPDATE SET slug = new WHERE slug IS NULL` (idempotent, double-tap safe); `POST {regenerate:true}` → `UPDATE SET slug = new`; `DELETE` → `UPDATE SET slug = NULL` ("stops ingestion; messages remain readable and still count against quota"). Tight rate limit (10/min/IP + per-account).

### 5.3 `api/cron/inbox-purge.mjs`

`cronAuth`-protected, daily via `vercel.json` crons. (a) Hard-deletes tombstones older than 30 days. (b) **Byte-pressure pass:** where a user's physical bytes (live + tombstoned) exceed 2× cap, hard-delete their oldest tombstones until under — live-only quota accounting must not let tombstoned disk grow unbounded within the 30-day grace. Purge is byte-neutral by construction (quota never counted tombstoned rows). Batched statements; `{ error }` checked per batch (landmine 11).

### 5.4 `server.js` dev mirror + dev loop

All three routes registered in Hono importing the same `lib/` modules. Documented dev loop: `curl` a captured `.eml` at the local ingest route with the dev secret — the pipeline is exercisable end-to-end before any Cloudflare config exists. `email-worker/` joins the eslint and vitest gates (its handler logic is a pure exported function; the wrangler entry is a thin shell).

## 6. Quotas (day one)

| Quota | Value | On breach |
| --- | --- | --- |
| Messages per user (live rows) | 500 | Defer (grace ladder §5.1); never prune. |
| Stored bytes per user (live rows, derived) | 100 MB | Same. Effective ceiling `min(100 MB, 500 × 2 MB)`. |
| Sanitised message size | 2 MB (octets) | 413 → bounce. |
| Raw inbound size | 10 MB octets at API (CF's 25 MiB upstream) | 413 → bounce. |
| Ingest rate | 60/hr per user + global ceiling + unknown-recipient counter | 429 → transient. |
| Address ops | 10/min/IP + per-account | 429 to client. |

User remedies are instant (§4.2): delete a message, or "clear all read" — both direct RLS tombstones that free quota immediately. §7 surfaces an 80% banner and a 100% "inbox full — N messages deferred since <date>" state. Kill switch: `INGEST_DISABLED=1` env → all ingests transient-defer (owner lever during abuse; senders retry, nothing bounces). Global storage ceiling documented for the owner: 100 users at cap = 10 GB worst case on the shared Supabase project.

## 7. Client changes

### 7.1 Inbox tab

Sixth `BottomTabBar` item + `/inbox` route (tab bar padding tightens; 320 px fit verified in the drive). States: signed-out → sign-in prompt; no address → "Get your address" card; empty → onboarding hint with copyable address; list → sender/subject/excerpt/date/unread dot; 80%/100% quota banners; "Recently deferred" line when `deferredCount > 0` so a user can diagnose "nothing arrives". Freshness: refetch on tab visit and window focus + `PullToRefresh` (house component); unread badge from a `count`-only query, never a row fetch. Reads via new `src/lib/inboxData.js` (metadata columns only; body by id on open).

### 7.2 `inboxStore.js` + boot wiring

Zustand store: address state, list, unreadCount, quota fields, fetchList/fetchBody/markRead/remove/clearRead/requestAddress/regenerateAddress/removeAddress. Bootstrap in `authStore.initAuth` on BOTH session-restore and fresh sign-in (landmine 20). Sign-out: reset store (the `api-cache` delete shipped in 2E covers `/api/inbox-address` GETs — pinned by test since a rotated address must never show a stale slug).

### 7.3 Reader & heart

Route `/inbox/message/:id` (SPA rewrite already covers it) resolving under the viewer's own RLS — the owner sees the message, anyone else an empty state. Renders `html_body` through a **dedicated email DOMPurify profile** (§8.3), `text_body` fallback, else excerpt + "View original". Remote images stripped to placeholders at render; "Load images" swaps them in per message (Settings global opt-in exists). Fixed-width email tables are constrained by scoped reader CSS (`max-width:100%`, overflow guard) — 320 px drive-verified. Mark-read on open. Unsubscribe button when `unsubscribe_url` present, labelled with its target domain ("opens substack.com"), never auto-fired.

**Heart** saves through the existing `saveArticle` seam with the stored sanitised body passed as `preloadedArticle` (routes through the existing `capContent` clamp), `savedVia: 'inbox'`, `url` = the minted permalink, `id = articleId(permalink)` (identity stays single-sourced in `lib/articleId.js`). **Extractor ban, all three seams** (landmine 18): because `savedVia` does not survive a cloud round-trip (`localFromSavedRow` hardcodes `'sync'`), the guard is a shared predicate `isInboxRecord(rec) = savedVia === 'inbox' || isInboxPermalink(rec.url)` gating `saveArticle`'s extract branch, `retrySave`, `attachBodyToSaved`, and ReaderPage resolution — each with a `not.toHaveBeenCalled()` pin. `web_url` never reaches any of them.

### 7.4 Settings

"Email Inbox" section: address + copy, quota meter (live-derived, so it falls the instant mail is deleted), deferred-mail note, regenerate ("this permanently stops mail sent to the old address — update your subscriptions after" warning) and remove — both behind the new **in-app confirm** component (landmine 22; the premium-delete swap stays parked).

## 8. Security & privacy (binding rules, test-backed in §9)

1. **Apex untouchable.** No change to `clauding-lab.com` apex DNS/MX. All work scoped to the `masthead` subdomain records + Worker; the owner-handed step list names every record. The subdomain also gets `v=spf1 -all` + DMARC-reject records — nobody sends as this subdomain, so spoofing it should hard-fail everywhere.
2. **Ingest auth:** 32-byte secret, constant-time, fail-closed, dual-secret rotation (§5.1). The secret is the gate; CORS absence is not a security claim.
3. **Email HTML is hostile input, dual-sanitised with email-tuned profiles at BOTH layers** (the shipped article profiles would break newsletters: client `FORBID_ATTR: ['style']` strips all inline styles — verified 2026-07-31). Server `lib/sanitizeEmail.js`: tables + inline styles survive **under a CSS property allowlist** (color/background/font/text/spacing/borders/width — never position, z-index, or fixed/absolute overlay vectors); scripts, event handlers, forms, iframes, `javascript:`/`cid:` URLs, ≤2px images stripped; links forced `target="_blank" rel="noopener noreferrer"`. Client: new `sanitizeEmailHtml` DOMPurify profile used ONLY by the inbox surface — the article profile is untouched (no global widening). XSS vector table includes email-specific payloads.
4. **Zero server-side fetches of sender-controlled URLs.** The ingest path parses only. `web_url`/`unsubscribe_url` are display-only link-outs. The extractor ban (§7.3) closes the heart-time path; inbox saves carry only minted permalinks.
5. **Log privacy:** bodies, subjects, and slugs never logged (the slug is the mailbox key — log the address-row id); log carries row id, dedupe-key hash, sizes, verdict codes.
6. **`{ error }` checked on every supabase call** (landmine 11); purge batches sized so one bad row cannot strand a run.
7. **Public repo discipline** (landmine 10).
8. **Abuse posture, stated honestly** (red-team №6 rewrote this): a leaked slug lets a third party write junk into one inbox and, at quota, defer legitimate mail — it can never delete stored messages (no prune) and never silently unsubscribes senders (defer-within-grace). Regenerate is an instant kill. Residual risk accepted on those corrected terms. Rate limits + derived quotas + kill switch bound cost.

## 9. Testing

- **Custody probes (`npm run probe-inbox`):** addresses — all verbs denied for anon AND authenticated; messages — anon all denied; authenticated cannot INSERT/DELETE, cannot touch others' rows, CAN update only `read_at`/`deleted_at` on own rows; trigger function EXECUTE denied (has_function_privilege). **DB-level concurrency probe** (service-role + PROBE_USER_ID, 2E cap-probe pattern): N parallel ingests → live rows ≤ 500 and `sum(size_bytes)` ≤ cap; byte totals asserted with `toBe` after a multi-byte-fixture round-trip (ingest → tombstone → purge), catching the chars-vs-octets class a mocked client cannot.
- **Ingest:** constant-time + forced-throw → 401 + `_PREV` rotation; pipeline order (unknown recipient and rate-limit never reach the parser; dedupe precedes quota); each §3 verdict row incl. 422 and grace-ladder transitions (within/beyond 7 days, `over_quota_since` set/cleared); dedupe with and without Message-ID; **ingest issues INSERT only** (spied service-role client — the load-bearing "inbound mail never mutates stored data" pin); `INGEST_DISABLED` defers.
- **Worker (pure handler, mocked fetch):** every verdict row; foreign/bare responses (no `x-masthead-ingest` header) → transient, never reject; size guard; envelope passthrough.
- **Real fixtures (landmine 15 spirit):** captured `.eml` from Substack, beehiiv, Mailchimp + a pathological fixture (deep nesting, malformed headers, 8-bit charsets, NUL bytes) — parse, sanitise, `size_bytes`, excerpt, web_url/unsubscribe/auth_results extraction all against real payloads. `messageBytes` unit-tested on emoji/CJK/astral-plane fixtures with exact octet counts.
- **Sanitiser:** XSS table; style-property allowlist (position/z-index stripped, color/font kept); tracker-pixel strip; table preservation; link attrs; client email profile allows styles while the article profile still strips them (both directions pinned).
- **Address API:** idempotent create (double-tap → one row); regenerate/remove are row-preserving (exactly one row across create→remove→create; quota figures unchanged; message 61 after a rotate still 429s); old slug 404s immediately.
- **Client:** initAuth bootstrap both paths; sign-out reset; tab state machine incl. quota banners and deferred note; badge via count query; reader inbox mode + image-blocking toggle; **all three extractor seams refuse inbox records even when `savedVia` arrives as `'sync'`** (the round-trip direction that actually fails); heart → cloud row (isCloudSyncable true, CHECK-satisfying permalink) surviving a sign-out/sign-in round-trip; un-heart tombstones; bulk clear-read frees the meter; unsubscribe domain label; in-app confirms. In-repo dom harness (landmine 19).
- **Cron:** cronAuth 401; hard-deletes only eligible tombstones; byte-pressure pass; purge is byte-neutral for the live quota.
- **Live drive (prod, owner's Chrome):** get address → owner subscribes a real Substack → message arrives → renders clean at 320px, images blocked then loaded on tap, no `/api/extract` in the network log → mark-read → heart → visible in Saved → **second-session check:** sign out/in, hearted item still opens with body and refuses extraction → delete mail, meter falls instantly → regenerate → old address bounces → drive-log equality check: meter equals `sum(size_bytes)` by read-only query. Log sweep: no body content in Vercel logs.

## 10. Rollout & proof-of-done

1. **3A PR (pipeline):** migration staged, `lib/` modules + 3 routes + Worker + probe + tests. Gates: `npm test` exit 0 (vs 358 baseline), build exit 0, eslint zero-new. Merge on green. Vercel functions config gains `inbox-ingest` (maxDuration 30) + purge cron entry.
2. **Owner-gated batch (once, after 3A merge, ORDERED — red-team: no mail may flow before its dependencies):** (a) Cloudflare dashboard pre-check: subdomain Email Routing configurable without apex MX changes — if not, execute the §2 fallback decision rule; (b) owner regenerates the CF API token (scopes listed in the handover); (c) owner runs the migration in-session (landmine 14); (d) `INGEST_SECRET` set in Vercel and redeployed + verified; (e) agent configures subdomain routing + deploys Worker with secrets; (f) **catch-all rule activated LAST**; (g) agent verifies by reads (to_regclass, grants, probes all-PASS) then real email end-to-end.
3. **3B PR (Inbox UI):** tab/store/reader/Settings + tests. Same gates. Merge on green.
4. **Live drive** per §9; deployment SHA verified (deploy ≠ push).
5. **AGENTS.md same-PR updates:** landmine 18 amended (inbox rule + the `savedVia`-not-durable-across-sync fact — which is also a latent premium-shell exposure, recorded as a flagged follow-up outside Phase 3 scope); new landmine: Postgres `length()` is characters — anything named bytes comes from `lib/inboxSize.js`; gates-table baseline update. AGENT_LEARNINGS entries per incident policy.

## 11. Out of scope

Sending/replying; attachments; multi-address; vanity slugs; sender allow/block lists; forwarding-migration tooling for existing subscriptions; one-click List-Unsubscribe POST; auto-filing rules; digests; offline/IndexedDB inbox cache (inbox is cloud-only — an accepted departure from local-first, revisit post-launch); inbox reads entering History; changes to premium/blogs/news pipelines, shared store, cron poller, catalog; premium-delete confirm swap (component ships, swap parked); the dedicated product domain (Phase 4 path, pre-decided fallback aside); fixing the latent premium `savedVia` round-trip exposure (flagged, tracked, not this phase).

## 12. Review log

- 2026-07-30 owner Q&A (§2): domain (corrected from third-party `clauding.com`), Inbox tab, full autonomous batch, postal-mime.
- 2026-07-30 design approved in-session by owner ("approved, write the spec and start the run").
- 2026-07-31 **spec red-team** (autonomous gate per approved batch; 4 adversarial Opus lenses × independent Opus skeptics, 14 agents, 75 raw findings): 10 verified (9 survived, 1 killed — slug-reuse-across-users, refuted on entropy); remaining 65 clustered against survivors and platform facts — every critical/high traced to an applied amendment or a directly verified fact (Vercel 100 MB body limit current; client sanitizer `FORBID_ATTR: ['style']` confirmed by file read). Headline amendments: derived byte quota + per-row `size_bytes` + DB-trigger enforcement; row-preserving address verbs; defer-don't-destroy quota posture with 7-day grace; verdict-authenticated SMTP mapping; minted-permalink heart identity + three-seam extractor ban via durable predicate; email-tuned sanitisation profiles BOTH layers with CSS property allowlist; images blocked by default; freshness + quota visibility surfaces; ordered rollout with catch-all last.
- Autonomous decisions taken under the batch (flag-for-owner, none blocking): 7-day grace number; bulk "clear read" ships in 3B; images-blocked-by-default (privacy-first default with per-message override); permalink over device-only saves. Say the word to change any — all are config-grade.
