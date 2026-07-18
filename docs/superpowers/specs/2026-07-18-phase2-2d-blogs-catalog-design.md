# Phase 2 · Slice 2D — Blogs & Newsletters + Expanded Catalog

**Date:** 2026-07-18
**Depends on:** 2A (UI language), 2B (store + poller), 2C (save pipeline) — all shipped.
**Unblocks:** 2E (premium feeds) and Phase 3 (email inbox) — both add sources that flow through the `kind` model this slice introduces.

---

## 1. Goal

Give blogs and newsletters a first-class home in Masthead — a dedicated fifth tab, fed by RSS — and grow the curated catalog from 10 news sources to 36 across news, blogs/newsletters, and outlets' Bluesky/Mastodon accounts. Ship the slug-alias mechanism (2B spec §10 carried item) so future catalog renames never break stale PWA clients.

## 2. Scope decisions (owner Q&A, 2026-07-18)

| Question | Decision |
| --- | --- |
| Where does Blogs & Newsletters live? | **5th bottom tab** (Feed · Blogs · Saved · History · Settings). First-class destination; nothing about the News feed changes. |
| Where do user-added custom feeds go? | **User picks on add** — Add Source modal gains a News / Blogs choice with domain-based auto-suggestion (substack.com, ghost.io, beehiiv.com, medium.com, buttondown → Blogs). |
| Where do Bluesky/Mastodon accounts live? | **"Social" chip in the News tab, excluded from "All"** — an opt-in stream; avoids flooding the default feed with short posts and near-duplicates. |
| How is the catalog slate curated? | **Agent proposes, owner strikes** — the full verified slate is in §6 of this spec; the owner edits it at spec review. Inclusion criteria written down (§6.3). |
| Architecture | **Approach A** — a `kind` field on sources; client-driven selection; no DB migration, no new endpoints. |

Carried nits folded in: `canonicalizeUrl` misses BBC `at_medium`/`at_campaign` params (fix in §5.2); slug aliases (§5.1).

## 3. Data model

### 3.1 `lib/sources.json` — two new optional per-source fields

- **`kind`**: `"news"` | `"blog"` | `"social"`. **Absent ⇒ `"news"`** — all 10 existing entries are untouched and all custom sources already in users' localStorage remain news without migration.
- **`aliases`**: array of former ids for this source. Absent ⇒ `[]`. Ships as the *mechanism* only — no entry has aliases at launch.

Custom sources (localStorage) carry the same `kind` field, set by the Add Source modal choice. A custom source without `kind` (pre-2D) is treated as `news` everywhere.

### 3.2 No database change

`public.articles` already stores `category` per row; blog and social sources are just more catalog rows — polled every 20 minutes, pruned at 14 days, served by the existing id-driven read path. **No migration, no RLS change, no owner-run DDL this slice.**

### 3.3 Category namespace

Blog categories (`economics`, `finance`, `strategy`, `tech`, `productivity`, `football`) share one namespace with news categories (`bangladesh`, `macro`, `tech`). No clash: each surface derives its chips only from its own sources (§4.3). `tech` deliberately appears in both news and blogs. Social sources reuse the category of the outlet they mirror; the Social chip selects by `kind`, not category. All category ids are single lowercase words (the chip label is derived by capitalizing the first letter).

Note: the `categories` array in `sources.json` is consumed by no code today (chips derive from `source.category`; verified 2026-07-18). It stays as optional documentation; the structural test only forbids it contradicting source entries.

## 4. Client IA

### 4.1 Navigation

`BottomTabBar` gains a fifth tab: **Feed · Blogs · Saved · History · Settings** (icon: `rss` or closest existing glyph in `ui/Icon`). New route `/blogs` renders the same `FeedLayout` pattern as `/` — same `TopBar`, chips row, card list — parameterized by kind. Route `/` (News) is untouched.

### 4.2 Feed state — store factory

`src/stores/feedStore.js` becomes a factory: `createFeedStore(kindSelector)` producing two module-level instances, `useNewsFeedStore` and `useBlogsFeedStore`. Each holds its own `headlines`, `selectedCategory`, `fetchedAt`, `isLoading`, `error`, and request-sequence guard. `FeedPage`, `CategoryTabs`, and `TopBar` accept the store (or its values) as props; internals unchanged. Existing imports of the default store resolve to the news instance.

### 4.3 Which sources each surface requests

The server keeps serving whatever ids the client asks for; the news/blogs/social split is a client *selection* concern, consistent with the app's existing model (the server has never known which sources a user enabled).

| Surface | Sources sent to `/api/feeds` |
| --- | --- |
| News tab — "All" + category chips | enabled sources with `kind: "news"` (category filter as today) |
| News tab — **Social** chip | enabled `kind: "social"` sources only, no category filter |
| Blogs tab — "All" + its own chips | enabled `kind: "blog"` sources (chips derived from their categories) |

The Social chip is **always visible** in the News tab (discovery); with no social sources enabled it renders an empty state with an inline enable-picker. "All" in the News tab = news-kind only — social posts never leak into it.

### 4.4 Enablement defaults

- **New users:** onboarding unchanged — news catalog enabled by default, onboarding screen stays news-only. Blog and social sources start **disabled**.
- **Existing users:** nothing changes silently. No new source is auto-enabled; stored `selectedSourceIds` are only touched by alias healing (§5.1), which rewrites ids 1:1, never adds or removes.
- **Blogs tab first visit** (no blog sources enabled): empty state renders the curated blog catalog as a one-tap picker ("choose a few to follow"). Same pattern for the Social chip.
- Settings' source management groups by kind (News / Blogs / Social headings).

### 4.5 Add Source modal

Gains an "Appears in" choice: News feed / Blogs & Newsletters. Auto-suggestion: if the URL's hostname (or discovered feed URL's hostname) ends with `substack.com`, `ghost.io`, `beehiiv.com`, `medium.com`, or `buttondown.email` → preselect Blogs; otherwise News. The user can always override. The chosen `kind` is stored on the custom source object.

### 4.6 Social cards link out

Cards for `kind: "social"` sources open the original post URL directly (new tab / external), bypassing the reader. Rationale: Bluesky/Mastodon post pages are JS apps that Readability extracts poorly; an honest link-out beats a broken reader. The heart (save) still works on social cards — it saves link + metadata; body extraction may file a retry shell, which the 2C pipeline already handles. All other kinds keep today's reader flow.

## 5. Server changes (all in existing modules)

### 5.1 Slug aliases — `lib/feedService.js` + `src/stores/settingsStore.js`

- **Server:** `catalogById` additionally indexes every entry under each id in its `aliases`, mapping to the canonical entry. A request carrying a stale id resolves to the canonical id before the store query; responses always carry canonical ids. Alias resolution applies in both the POST branch (id classification) and the GET branch (`?source=` filter).
- **Client:** on boot, `settingsStore` runs stored `selectedSourceIds` through the same alias map (built from the imported `sources.json`) and persists the healed list. Stale localStorage heals on first load after an app update.
- **Store rows** under a renamed slug are not migrated — they age out via the existing 14-day prune while the poller writes rows under the canonical slug from the next run.
- **House rule (governance, §6.4): never hard-rename a catalog slug — add the old id to `aliases` and change `id` in the same commit.**

### 5.2 Tracking-param sweep — `lib/articleId.js`

`canonicalizeUrl` currently strips a fixed param list but misses BBC's `at_medium`/`at_campaign`. Fix: strip any query param whose name starts with `at_` (analogous to existing `utm_` handling). Ids change only for hand-pasted URLs carrying `at_*` params; feed-derived ids are unaffected — **no re-key migration**.

### 5.3 Polling scale — measure, don't change

The cron poller reads `sources.json` and picks up all 36 sources automatically. Last measured run: 7.4 s for 10 feeds; worst-case linear scaling ≈ 27 s against a 300 s function ceiling. No code change; the rollout (§10) includes one measured full poll run as proof. Bluesky/Mastodon emit standard RSS; fixture tests (§8) prove the existing parser handles both.

## 6. Catalog slate (verified 2026-07-18, ~19:45 BDT, from the owner's Mac)

Every feed below returned HTTP 200 with parseable RSS/Atom XML and ≥1 real item on 2026-07-18. Item counts are as-measured that day. Candidates that failed verification were dropped: Dhaka Tribune (`/feed/rss` returns an empty channel), Financial Express BD (404), BBC's Bluesky account (`bbcnews.bsky.social` RSS exists but contains zero posts), The Daily Star Bluesky (no account).

### 6.1 Existing 10 (unchanged, gain `kind: "news"` implicitly)

daily-star, business-standard-bd, bbc-bangla (bangladesh) · project-syndicate, al-jazeera, bbc-news (macro) · techcrunch, hacker-news, the-verge, the-rundown-ai (tech).

> The Rundown AI is a beehiiv newsletter currently filed under news/tech. **Owner call at review:** move it to `kind: "blog"`, category `tech` (recommended — it is a newsletter, and Blogs is now the honest home) or leave as news. Moving it is a `kind` edit only; the id, store rows, and user selections are unaffected.

### 6.2 New entries (26)

**News — 6** (`kind: "news"`)

| id | Name (shortName) | category | feedUrl | items |
| --- | --- | --- | --- | --- |
| prothom-alo-en | Prothom Alo English (PA) | bangladesh | `https://en.prothomalo.com/feed/` | 2 |
| guardian-world | The Guardian — World (GDN) | macro | `https://www.theguardian.com/world/rss` | 45 |
| npr-news | NPR News (NPR) | macro | `https://feeds.npr.org/1001/rss.xml` | 10 |
| the-diplomat | The Diplomat (TD) | macro | `https://thediplomat.com/feed/` | 96 |
| ars-technica | Ars Technica (ARS) | tech | `https://feeds.arstechnica.com/arstechnica/index` | 20 |
| rest-of-world | Rest of World (ROW) | tech | `https://restofworld.org/feed/latest/` | 12 |

**Blogs & newsletters — 14** (`kind: "blog"`)

| id | Name (shortName) | category | feedUrl | items |
| --- | --- | --- | --- | --- |
| marginal-revolution | Marginal Revolution (MR) | economics | `https://marginalrevolution.com/feed` | 15 |
| noahpinion | Noahpinion (NP) | economics | `https://www.noahpinion.blog/feed` | 7 |
| chartbook | Chartbook — Adam Tooze (CB) | economics | `https://adamtooze.substack.com/feed` | 16 |
| bits-about-money | Bits about Money (BAM) | finance | `https://www.bitsaboutmoney.com/archive/rss/` | 15 |
| net-interest | Net Interest (NI) | finance | `https://www.netinterest.co/feed` | 19 |
| stratechery | Stratechery (ST) | strategy | `https://stratechery.com/feed/` | 10 |
| ben-evans | Benedict Evans (BE) | strategy | `https://www.ben-evans.com/benedictevans?format=rss` | 20 |
| simon-willison | Simon Willison (SW) | tech | `https://simonwillison.net/atom/everything/` | 30 |
| one-useful-thing | One Useful Thing (OUT) | tech | `https://www.oneusefulthing.org/feed` | 20 |
| import-ai | Import AI (IAI) | tech | `https://importai.substack.com/feed` | 20 |
| farnam-street | Farnam Street (FS) | productivity | `https://fs.blog/feed/` | 20 |
| cal-newport | Cal Newport (CN) | productivity | `https://calnewport.com/feed/` | 8 |
| ff-scout | Fantasy Football Scout (FFS) | football | `https://www.fantasyfootballscout.co.uk/feed/` | 12 |
| busby-babe | The Busby Babe (TBB) | football | `https://thebusbybabe.sbnation.com/rss/index.xml` | 10 |

**Social — 6** (`kind: "social"`; category mirrors the outlet)

| id | Name (shortName) | category | feedUrl | items |
| --- | --- | --- | --- | --- |
| guardian-bsky | The Guardian 🦋 (GDN) | macro | `https://bsky.app/profile/theguardian.com/rss` | 30 |
| aljazeera-bsky | Al Jazeera 🦋 (AJ) | macro | `https://bsky.app/profile/aljazeera.com/rss` | 30 |
| npr-bsky | NPR 🦋 (NPR) | macro | `https://bsky.app/profile/npr.org/rss` | 30 |
| verge-bsky | The Verge 🦋 (TV) | tech | `https://bsky.app/profile/theverge.com/rss` | 24 |
| techcrunch-bsky | TechCrunch 🦋 (TC) | tech | `https://bsky.app/profile/techcrunch.com/rss` | 28 |
| ars-mastodon | Ars Technica 🐘 (ARS) | tech | `https://mastodon.social/@arstechnica.rss` | 20 |

Colors: new entries get brand-appropriate hex values chosen at implementation (existing palette conventions); not load-bearing for review.

### 6.3 Inclusion criteria (for this slate and all future catalog PRs)

1. Working **public** RSS/Atom feed — HTTP 200, parseable XML, verified at PR time.
2. **Active**: ≥1 item published in the trailing 60 days (empty channels fail — see Dhaka Tribune).
3. **No hard paywall** on linked articles (metered/free-tier acceptable; subscriber-only feeds belong to 2E).
4. Full-text feeds preferred; link-only acceptable (reader extraction covers the body).
5. Serves the app's audience: Bangladesh + macro/geopolitics + tech/AI + the owner's blog categories.

### 6.4 Governance

- The catalog is code: additions/removals arrive by PR editing `lib/sources.json`, and the structural test suite (§8) gates them.
- **Never hard-rename a slug** — rename via `aliases` (§5.1).
- Removing a source: delete the entry; store rows age out via prune; client selections referencing a deleted id are simply never matched (harmless), same as today.

### 6.5 Verification caveat — BD egress vs Vercel egress

The slate was verified from the owner's Mac (Bangladesh residential egress). The poller runs from Vercel `bom1` — a feed reachable from BD may in principle behave differently from a datacenter IP (precedent: Bangladesh Bank/DSE block EU/US datacenter egress in EconDelta). The §10 post-deploy poll-run measurement is the authoritative per-feed pass/fail; any feed failing from `bom1` gets struck from the catalog in the same PR cycle.

## 7. Edge cases

- **Empty Blogs tab / Social chip** → curated one-tap picker empty state (§4.4).
- **Partial feed failures** → existing per-feed stats and warm-store logic already tolerate them; a dead blog feed contributes zero rows, UI unaffected.
- **Custom source without `kind`** (pre-2D localStorage) → `news`, exactly where it lives today.
- **Alias collision** (an alias equal to a live id) would silently shadow a source → forbidden by structural test (§8).
- **PWA-cache drift after a future rename** → server resolves stale ids via aliases; client heals localStorage on boot; old store rows prune out (§5.1).
- **Social post duplicating a story already in the outlet's RSS** → accepted; the Social chip is an opt-in, segregated stream (§4.3), so duplicates never sit side-by-side in "All".
- **Share-target, Saved, History, Reader** → untouched surfaces; blog articles flow the existing reader/extract path; social cards bypass it (§4.6).

## 8. Testing

Extends the current 148-test vitest suite:

- **Catalog structural suite** (new): unique ids; aliases collide with no live id and no other alias; `kind` ∈ {news, blog, social} or absent; feedUrl is well-formed https; every source's `category` is a single lowercase word; the (unconsumed) `categories` array, if present, contradicts no source entry (§3.3).
- **Alias resolution**: `feedService` — canonical id, aliased id, unknown id, `?source=` GET filter through an alias; `settingsStore` boot healing rewrites stale ids 1:1 and persists.
- **Store factory**: two instances hold independent category/headline state; request-sequence guard per instance.
- **`canonicalizeUrl`**: `at_medium`/`at_campaign`/`at_*` stripped (BBC fixture URL); existing behavior unchanged for non-`at_` params.
- **Feed parser fixtures**: one real Bluesky RSS payload, one real Mastodon RSS payload → parsed items with title/link/date.
- **Add Source modal**: kind auto-suggestion per domain list; override persists.
- **`scripts/verify-catalog.mjs`** (new, standalone): fetches all catalog feedUrls, asserts 200 + XML + ≥1 item; run manually during build and pre-merge — **not in CI** (36 network calls make a flaky gate). CI keeps the structural suite only.
- **UI live-drive** (pre-merge): both themes at 390/768 px — Blogs tab, Social chip, both empty-state pickers, Add Source with kind choice, a blog article through the reader, a social card link-out.

## 9. Out of scope

Premium/subscriber feeds (2E); email newsletter ingestion (Phase 3); storing blog full-text bodies at poll time (reader extraction covers 2D; revisit with Phase 3); social-post rendering beyond standard cards (rich embeds, threads); per-source polling cadence; server-side awareness of kind; X/Threads (no free API); onboarding redesign.

## 10. Rollout & proof-of-done

1. Branch → PR with the full slice; house gates (tests, build + bundle guard, lint baseline 3, `verify-catalog.mjs` output pasted into the PR).
2. Spec red-team before code; adversarial code review before merge (house process — both with countable verdicts).
3. Merge → deploy → **proof**: (a) one measured full poll run — duration + per-feed stats, all 36 attempted, failures enumerated; (b) anon REST query showing blog + social rows in the store; (c) live drive of Blogs tab + Social chip on masthead-news.vercel.app, both themes; (d) headers/PWA manifest intact (share_target survives).
4. Any feed dead from `bom1` (§6.5) is struck in a follow-up commit, criteria note updated.

## 11. Review log

*(to be filled by the pre-code spec red-team and the pre-merge code review, per house process)*
