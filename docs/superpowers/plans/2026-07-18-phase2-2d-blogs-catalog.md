# Phase 2 · Slice 2D — Blogs & Newsletters + Expanded Catalog: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fifth "Blogs" tab fed by a `kind`-aware 36-source catalog, a Social chip in the News tab, slug-alias resolution, and the `at_*` tracking-param sweep — with zero database changes.

**Architecture:** Approach A from the approved spec (`docs/superpowers/specs/2026-07-18-phase2-2d-blogs-catalog-design.md`): sources gain `kind` (`news`/`blog`/`social`, absent ⇒ news) and `aliases` fields in `lib/sources.json`; the news/blogs/social split is a client *selection* concern (which source ids each surface requests); the server only gains alias resolution. The poller, store, RLS, and endpoints are untouched.

**Tech Stack:** React 19 + Vite PWA, Zustand, vitest (jsdom for client tests), rss-parser, Vercel functions, Supabase (read-only this slice).

## Global Constraints

- Branch: `phase2-2d-blogs-catalog` (already exists, spec committed as `62d54e4`). Never push/merge main directly; ship via PR.
- Gates (run full, never piped through `tail`/`head`/`grep`): `npm test` (148 tests pre-slice, all must stay green), `npm run build` (includes `scripts/check-bundle.mjs` service-role leak scan), `npx eslint .` baseline = exactly 3 pre-existing `set-state-in-effect` errors (PageTransition, SavedPage, HistoryPage) — zero NEW errors.
- Dev servers only inside tmux: `tmux new-session -d -s dev "npm run dev"` (house hook blocks otherwise).
- No prod DDL, no new env vars, no new endpoints this slice.
- Files ≤800 lines; match existing style (JSX + inline `style={{}}` with CSS vars, no TypeScript).
- App dark mode = `documentElement.className='dark'` (NOT `data-theme`).
- Spec §6.1 owner decision (approved): `the-rundown-ai` moves to `kind: "blog"`.
- Commit per task, Conventional Commits, no attribution trailers.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `lib/catalogIndex.js` (+ test) | Create | Pure alias-aware catalog index; shared server+browser |
| `lib/articleId.js` (+ test) | Modify | `at_*` tracking-param sweep |
| `lib/sources.json` | Modify | 36-source catalog with `kind` |
| `lib/catalog.test.js` | Create | Structural catalog validation (CI-safe, no network) |
| `lib/feedParser.js` (+ test, 2 fixtures) | Modify | Title fallback for title-less social posts |
| `lib/feedService.js` (+ test) | Modify | Alias resolution in POST + GET branches |
| `src/lib/sourceKind.js` | Create | One-line `kind ?? 'news'` helper |
| `src/lib/feedCategories.js` (+ test) | Create | Pure chip-derivation for News (incl. Social) and Blogs tabs |
| `src/lib/suggestKind.js` (+ test) | Create | Domain-based kind auto-suggestion |
| `src/stores/settingsStore.js` (+ new test) | Modify | Kind selectors, alias healing, news-only default |
| `src/stores/feedStore.js` (+ test) | Modify | Store factory → news + blogs instances |
| `src/components/ui/Icon.jsx` | Modify | `blogs` glyph |
| `src/components/BottomTabBar.jsx` | Modify | 5th tab |
| `src/pages/FeedLayout.jsx` | Create | Extracted parameterized layout (mode: news/blogs) |
| `src/App.jsx` | Modify | `/blogs` route; slim down |
| `src/components/CategoryTabs.jsx` | Modify | Dumb: `categories` as prop |
| `src/components/SourcePickerEmptyState.jsx` | Create | One-tap curated picker for empty Blogs/Social |
| `src/pages/FeedPage.jsx` | Modify | `store` + `linkOut` props |
| `src/components/HeadlineCard.jsx` | Modify | `linkOut` external-anchor variant |
| `src/components/AddSourceModal.jsx` | Modify | News/Blogs choice |
| `src/pages/OnboardingPage.jsx` | Modify | News-kind-only onboarding |
| `src/pages/SettingsPage.jsx` | Modify | Kind-grouped source sections |
| `scripts/verify-catalog.mjs`, `package.json` | Create/Modify | Manual 36-feed health check |

---

### Task 1: `lib/catalogIndex.js` — alias-aware catalog index

**Files:**
- Create: `lib/catalogIndex.js`
- Test: `lib/catalogIndex.test.js`

**Interfaces:**
- Consumes: nothing (pure, zero imports — keeps `lib/securityBoundary.test.js`'s src→lib import walk clean).
- Produces: `buildCatalogIndex(catalog) → { byId: Map<string, entry>, canonicalId(id: string) → string|null, has(id) → boolean }`. Live ids always win over aliases. Used by Task 5 (feedService) and Task 6 (settingsStore).

- [ ] **Step 1: Write the failing test**

```js
// lib/catalogIndex.test.js
import { describe, it, expect } from 'vitest';
import { buildCatalogIndex } from './catalogIndex.js';

const CATALOG = {
  sources: [
    { id: 'new-slug', name: 'A', aliases: ['old-slug', 'older-slug'] },
    { id: 'plain', name: 'B' },
    { id: 'taken', name: 'C', aliases: ['plain'] }, // collision: live id must win
  ],
};

describe('buildCatalogIndex', () => {
  const idx = buildCatalogIndex(CATALOG);
  it('resolves a canonical id to itself', () => {
    expect(idx.canonicalId('new-slug')).toBe('new-slug');
  });
  it('resolves an alias to its canonical id', () => {
    expect(idx.canonicalId('old-slug')).toBe('new-slug');
    expect(idx.canonicalId('older-slug')).toBe('new-slug');
  });
  it('returns null for an unknown id', () => {
    expect(idx.canonicalId('nope')).toBeNull();
  });
  it('a live id always beats an alias claiming it', () => {
    expect(idx.canonicalId('plain')).toBe('plain');
  });
  it('has() covers live ids and aliases', () => {
    expect(idx.has('old-slug')).toBe(true);
    expect(idx.has('nope')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/catalogIndex.test.js`
Expected: FAIL — cannot find module `./catalogIndex.js`.

- [ ] **Step 3: Write the implementation**

```js
// lib/catalogIndex.js
// Alias-aware catalog index (2D spec §5.1). Pure JS with zero imports so
// server (feedService) and browser (settingsStore healing) share it, like
// articleId. Live ids are registered before aliases, so a live id always
// wins if an alias mistakenly claims it (the structural catalog test
// forbids that state in the real catalog anyway).

export function buildCatalogIndex(catalog) {
  const byId = new Map();
  for (const source of catalog.sources) {
    byId.set(source.id, source);
  }
  for (const source of catalog.sources) {
    for (const alias of source.aliases ?? []) {
      if (!byId.has(alias)) byId.set(alias, source);
    }
  }
  return {
    byId,
    canonicalId(id) {
      const entry = byId.get(id);
      return entry ? entry.id : null;
    },
    has(id) {
      return byId.has(id);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/catalogIndex.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/catalogIndex.js lib/catalogIndex.test.js
git commit -m "feat(catalog): alias-aware catalog index shared by server and browser"
```

---

### Task 2: `canonicalizeUrl` — sweep `at_*` tracking params

**Files:**
- Modify: `lib/articleId.js:5-6` (the `TRACKING_PARAM` regex only)
- Test: `lib/articleId.test.js` (append a describe block)

**Interfaces:**
- Produces: unchanged signatures — `canonicalizeUrl(raw) → string|null`, `articleId(input) → string|null`. Only ids of hand-pasted URLs carrying `at_*` params change; feed-derived ids are unaffected (no re-key migration).

- [ ] **Step 1: Write the failing test** (append to `lib/articleId.test.js`)

```js
describe('at_* tracking params (2D spec §5.2)', () => {
  it('strips BBC at_medium/at_campaign so pasted and feed URLs share an id', () => {
    const pasted = 'https://www.bbc.com/news/articles/c1234?at_medium=RSS&at_campaign=rss';
    const clean = 'https://www.bbc.com/news/articles/c1234';
    expect(canonicalizeUrl(pasted)).toBe(canonicalizeUrl(clean));
  });
  it('strips any at_-prefixed param, keeps non-prefixed lookalikes', () => {
    expect(canonicalizeUrl('https://x.example/a?at_link_origin=x&atlas=1'))
      .toBe('https://x.example/a?atlas=1');
  });
});
```

(`canonicalizeUrl` is already imported at the top of the existing test file; if not, add it to the existing import from `./articleId.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/articleId.test.js`
Expected: FAIL — the two new assertions (URLs keep `at_*` params today).

- [ ] **Step 3: Implement** — replace lines 5-6 of `lib/articleId.js`:

```js
const TRACKING_PARAM =
  /^(utm_.*|at_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|_hsenc|_hsmi|s_kwcid|yclid|cmpid|ito)$/;
```

- [ ] **Step 4: Run the full lib tests** (guards against regressions in dependent id tests)

Run: `npx vitest run lib/`
Expected: PASS, zero failures.

- [ ] **Step 5: Commit**

```bash
git add lib/articleId.js lib/articleId.test.js
git commit -m "fix(articleId): strip at_* tracking params (BBC at_medium/at_campaign)"
```

---

### Task 3: Expand `lib/sources.json` to 36 + structural catalog test

**Files:**
- Modify: `lib/sources.json`
- Test: `lib/catalog.test.js` (create)

**Interfaces:**
- Produces: catalog entries may carry `kind` (`"news"`|`"blog"`|`"social"`, absent ⇒ news) and `aliases` (string[], absent ⇒ none). All ids/feedUrls below were live-verified 2026-07-18 (spec §6). Consumed by every later task.

- [ ] **Step 1: Write the failing structural test**

```js
// lib/catalog.test.js
// Structural gate for lib/sources.json (2D spec §8). No network — the
// live-feed check is scripts/verify-catalog.mjs, run manually.
import { describe, it, expect } from 'vitest';
import catalog from './sources.json';

const REQUIRED = ['id', 'name', 'shortName', 'url', 'feedUrl', 'feedType', 'category', 'color'];
const KINDS = [undefined, 'news', 'blog', 'social'];

describe('catalog structure', () => {
  it('has 36 sources (2D slate)', () => {
    expect(catalog.sources).toHaveLength(36);
  });
  it('ids are unique', () => {
    const ids = catalog.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every source has the required fields', () => {
    for (const s of catalog.sources) {
      for (const f of REQUIRED) expect(s[f], `${s.id}.${f}`).toBeTruthy();
    }
  });
  it('kind, when present, is news|blog|social', () => {
    for (const s of catalog.sources) expect(KINDS, s.id).toContain(s.kind);
  });
  it('categories are single lowercase words', () => {
    for (const s of catalog.sources) expect(s.category, s.id).toMatch(/^[a-z]+$/);
  });
  it('feed URLs are well-formed https', () => {
    for (const s of catalog.sources) {
      expect(() => new URL(s.feedUrl), s.id).not.toThrow();
      expect(s.feedUrl.startsWith('https://'), s.id).toBe(true);
    }
  });
  it('aliases never collide with a live id or another alias', () => {
    const liveIds = new Set(catalog.sources.map((s) => s.id));
    const seenAliases = new Set();
    for (const s of catalog.sources) {
      for (const a of s.aliases ?? []) {
        expect(liveIds.has(a), `alias ${a} shadows a live id`).toBe(false);
        expect(seenAliases.has(a), `alias ${a} duplicated`).toBe(false);
        seenAliases.add(a);
      }
    }
  });
  it('the (unconsumed) categories array does not contradict itself', () => {
    const ids = catalog.categories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });
  it('the slate has the expected kind counts (15 news / 15 blog / 6 social)', () => {
    const kind = (s) => s.kind ?? 'news';
    expect(catalog.sources.filter((s) => kind(s) === 'news')).toHaveLength(15);
    expect(catalog.sources.filter((s) => kind(s) === 'blog')).toHaveLength(15);
    expect(catalog.sources.filter((s) => kind(s) === 'social')).toHaveLength(6);
  });
});
```

Count derivation: 10 existing sources minus `the-rundown-ai` (reclassified to blog, approved owner call) = 9 existing news + 6 new news = **15 news**; 14 new blogs + the-rundown-ai = **15 blogs**; **6 social**. 15+15+6 = 36 ✓.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/catalog.test.js`
Expected: FAIL — catalog has 10 sources.

- [ ] **Step 3: Edit `lib/sources.json`**

(a) Add `"kind": "blog"` to the existing `the-rundown-ai` entry (after its `"category"` line).
(b) Append these 26 entries to the `sources` array (after `the-rundown-ai`), leaving the `categories` array untouched:

```json
{ "id": "prothom-alo-en", "name": "Prothom Alo English", "shortName": "PA", "url": "https://en.prothomalo.com", "feedUrl": "https://en.prothomalo.com/feed/", "feedType": "rss", "category": "bangladesh", "color": "#D71920", "paywall": false, "kind": "news" },
{ "id": "guardian-world", "name": "The Guardian — World", "shortName": "GDN", "url": "https://www.theguardian.com/world", "feedUrl": "https://www.theguardian.com/world/rss", "feedType": "rss", "category": "macro", "color": "#052962", "paywall": false, "kind": "news" },
{ "id": "npr-news", "name": "NPR News", "shortName": "NPR", "url": "https://www.npr.org", "feedUrl": "https://feeds.npr.org/1001/rss.xml", "feedType": "rss", "category": "macro", "color": "#1A79C7", "paywall": false, "kind": "news" },
{ "id": "the-diplomat", "name": "The Diplomat", "shortName": "TD", "url": "https://thediplomat.com", "feedUrl": "https://thediplomat.com/feed/", "feedType": "rss", "category": "macro", "color": "#B01E24", "paywall": false, "kind": "news" },
{ "id": "ars-technica", "name": "Ars Technica", "shortName": "ARS", "url": "https://arstechnica.com", "feedUrl": "https://feeds.arstechnica.com/arstechnica/index", "feedType": "rss", "category": "tech", "color": "#FF4E00", "paywall": false, "kind": "news" },
{ "id": "rest-of-world", "name": "Rest of World", "shortName": "ROW", "url": "https://restofworld.org", "feedUrl": "https://restofworld.org/feed/latest/", "feedType": "rss", "category": "tech", "color": "#F05B4C", "paywall": false, "kind": "news" },
{ "id": "marginal-revolution", "name": "Marginal Revolution", "shortName": "MR", "url": "https://marginalrevolution.com", "feedUrl": "https://marginalrevolution.com/feed", "feedType": "rss", "category": "economics", "color": "#0E7C3A", "paywall": false, "kind": "blog" },
{ "id": "noahpinion", "name": "Noahpinion", "shortName": "NP", "url": "https://www.noahpinion.blog", "feedUrl": "https://www.noahpinion.blog/feed", "feedType": "rss", "category": "economics", "color": "#2563EB", "paywall": false, "kind": "blog" },
{ "id": "chartbook", "name": "Chartbook — Adam Tooze", "shortName": "CB", "url": "https://adamtooze.substack.com", "feedUrl": "https://adamtooze.substack.com/feed", "feedType": "rss", "category": "economics", "color": "#B45309", "paywall": false, "kind": "blog" },
{ "id": "bits-about-money", "name": "Bits about Money", "shortName": "BAM", "url": "https://www.bitsaboutmoney.com", "feedUrl": "https://www.bitsaboutmoney.com/archive/rss/", "feedType": "rss", "category": "finance", "color": "#0F766E", "paywall": false, "kind": "blog" },
{ "id": "net-interest", "name": "Net Interest", "shortName": "NI", "url": "https://www.netinterest.co", "feedUrl": "https://www.netinterest.co/feed", "feedType": "rss", "category": "finance", "color": "#92400E", "paywall": false, "kind": "blog" },
{ "id": "stratechery", "name": "Stratechery", "shortName": "ST", "url": "https://stratechery.com", "feedUrl": "https://stratechery.com/feed/", "feedType": "rss", "category": "strategy", "color": "#E03C31", "paywall": false, "kind": "blog" },
{ "id": "ben-evans", "name": "Benedict Evans", "shortName": "BE", "url": "https://www.ben-evans.com", "feedUrl": "https://www.ben-evans.com/benedictevans?format=rss", "feedType": "rss", "category": "strategy", "color": "#334155", "paywall": false, "kind": "blog" },
{ "id": "simon-willison", "name": "Simon Willison", "shortName": "SW", "url": "https://simonwillison.net", "feedUrl": "https://simonwillison.net/atom/everything/", "feedType": "rss", "category": "tech", "color": "#4338CA", "paywall": false, "kind": "blog" },
{ "id": "one-useful-thing", "name": "One Useful Thing", "shortName": "OUT", "url": "https://www.oneusefulthing.org", "feedUrl": "https://www.oneusefulthing.org/feed", "feedType": "rss", "category": "tech", "color": "#059669", "paywall": false, "kind": "blog" },
{ "id": "import-ai", "name": "Import AI", "shortName": "IAI", "url": "https://importai.substack.com", "feedUrl": "https://importai.substack.com/feed", "feedType": "rss", "category": "tech", "color": "#6D28D9", "paywall": false, "kind": "blog" },
{ "id": "farnam-street", "name": "Farnam Street", "shortName": "FS", "url": "https://fs.blog", "feedUrl": "https://fs.blog/feed/", "feedType": "rss", "category": "productivity", "color": "#1E3A8A", "paywall": false, "kind": "blog" },
{ "id": "cal-newport", "name": "Cal Newport", "shortName": "CN", "url": "https://calnewport.com", "feedUrl": "https://calnewport.com/feed/", "feedType": "rss", "category": "productivity", "color": "#0891B2", "paywall": false, "kind": "blog" },
{ "id": "ff-scout", "name": "Fantasy Football Scout", "shortName": "FFS", "url": "https://www.fantasyfootballscout.co.uk", "feedUrl": "https://www.fantasyfootballscout.co.uk/feed/", "feedType": "rss", "category": "football", "color": "#15803D", "paywall": false, "kind": "blog" },
{ "id": "busby-babe", "name": "The Busby Babe", "shortName": "TBB", "url": "https://thebusbybabe.sbnation.com", "feedUrl": "https://thebusbybabe.sbnation.com/rss/index.xml", "feedType": "rss", "category": "football", "color": "#DA291C", "paywall": false, "kind": "blog" },
{ "id": "guardian-bsky", "name": "The Guardian 🦋", "shortName": "GDN", "url": "https://bsky.app/profile/theguardian.com", "feedUrl": "https://bsky.app/profile/theguardian.com/rss", "feedType": "rss", "category": "macro", "color": "#052962", "paywall": false, "kind": "social" },
{ "id": "aljazeera-bsky", "name": "Al Jazeera 🦋", "shortName": "AJ", "url": "https://bsky.app/profile/aljazeera.com", "feedUrl": "https://bsky.app/profile/aljazeera.com/rss", "feedType": "rss", "category": "macro", "color": "#D2A04C", "paywall": false, "kind": "social" },
{ "id": "npr-bsky", "name": "NPR 🦋", "shortName": "NPR", "url": "https://bsky.app/profile/npr.org", "feedUrl": "https://bsky.app/profile/npr.org/rss", "feedType": "rss", "category": "macro", "color": "#1A79C7", "paywall": false, "kind": "social" },
{ "id": "verge-bsky", "name": "The Verge 🦋", "shortName": "TV", "url": "https://bsky.app/profile/theverge.com", "feedUrl": "https://bsky.app/profile/theverge.com/rss", "feedType": "rss", "category": "tech", "color": "#5100FF", "paywall": false, "kind": "social" },
{ "id": "techcrunch-bsky", "name": "TechCrunch 🦋", "shortName": "TC", "url": "https://bsky.app/profile/techcrunch.com", "feedUrl": "https://bsky.app/profile/techcrunch.com/rss", "feedType": "rss", "category": "tech", "color": "#0A9E01", "paywall": false, "kind": "social" },
{ "id": "ars-mastodon", "name": "Ars Technica 🐘", "shortName": "ARS", "url": "https://mastodon.social/@arstechnica", "feedUrl": "https://mastodon.social/@arstechnica.rss", "feedType": "rss", "category": "tech", "color": "#FF4E00", "paywall": false, "kind": "social" }
```

- [ ] **Step 4: Run the structural test + full suite** (sources.json is imported widely)

Run: `npx vitest run lib/catalog.test.js` → PASS.
Run: `npm test` → all pass (existing tests use their own fixtures; catalog growth must not break any).

- [ ] **Step 5: Commit**

```bash
git add lib/sources.json lib/catalog.test.js
git commit -m "feat(catalog): expand to 36 sources with kind field; structural test"
```

---

### Task 4: feedParser — title fallback for title-less social posts + real fixtures

**Files:**
- Modify: `lib/feedParser.js:44-68` (`mapFeedItems`)
- Create: `lib/__fixtures__/bluesky-rss.xml`, `lib/__fixtures__/mastodon-rss.xml`
- Test: `lib/feedParser.test.js` (append)

**Interfaces:**
- Produces: `mapFeedItems` unchanged signature; items with no `<title>` now take the first line of `contentSnippet` (≤140 chars) before falling back to `'Untitled'`. Verified against real Bluesky/Mastodon payloads (both are title-less — captured live 2026-07-18).

- [ ] **Step 1: Capture the fixtures** (real producer output, per house discipline #2)

```bash
mkdir -p lib/__fixtures__
curl -sL -m 20 "https://bsky.app/profile/theverge.com/rss" -o /tmp/bsky-full.xml
curl -sL -m 20 "https://mastodon.social/@arstechnica.rss" -o /tmp/masto-full.xml
```

Then trim each to the channel wrapper + the first 2 `<item>`s and save as `lib/__fixtures__/bluesky-rss.xml` / `lib/__fixtures__/mastodon-rss.xml`. Reference shapes (captured 2026-07-18 — your capture will have newer posts; keep whatever you fetched, the assertions below adapt):

Bluesky item shape: `<item><link>https://bsky.app/profile/theverge.com/post/…</link><description>POST TEXT&#xA;https://buff.ly/…</description><pubDate>18 Jul 2026 12:40 +0000</pubDate><guid isPermaLink="false">at://did:plc:…</guid></item>` — **no `<title>`**.
Mastodon item shape: `<item><guid isPermaLink="true">https://mastodon.social/@arstechnica/…</guid><link>…</link><pubDate>…</pubDate><description>&lt;p&gt;POST HTML…&lt;/p&gt;</description><media:content url="https://files.mastodon.social/…jpg" type="image/jpeg" …/></item>` — **no `<title>`**, has thumbnail. If the Mastodon fixture uses the `media:` namespace, keep the channel's `xmlns:media` attribute from the full capture (rss-parser needs the document to be namespace-valid).

- [ ] **Step 2: Write the failing test** (append to `lib/feedParser.test.js`)

```js
import { readFileSync } from 'node:fs';
import Parser from 'rss-parser';

const SOCIAL_SOURCE = { id: 'verge-bsky', name: 'The Verge 🦋', shortName: 'TV', color: '#5100FF', category: 'tech' };

async function parseFixture(name) {
  const xml = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
  const feed = await new Parser().parseString(xml);
  return feed.items;
}

describe('social feed fixtures (2D spec §8)', () => {
  it('Bluesky posts get the post text as title, not Untitled', async () => {
    const items = await parseFixture('bluesky-rss.xml');
    const mapped = mapFeedItems(items, SOCIAL_SOURCE);
    expect(mapped.length).toBeGreaterThan(0);
    for (const m of mapped) {
      expect(m.title).not.toBe('Untitled');
      expect(m.title.length).toBeLessThanOrEqual(140);
      expect(m.id).toMatch(/^[0-9a-f]{16}$/);
      expect(m.url).toMatch(/^https:\/\/bsky\.app\//);
    }
  });
  it('Mastodon posts get text titles and keep their media thumbnail', async () => {
    const items = await parseFixture('mastodon-rss.xml');
    const mapped = mapFeedItems(items, { ...SOCIAL_SOURCE, id: 'ars-mastodon' });
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped[0].title).not.toBe('Untitled');
    expect(mapped[0].thumbnail).toMatch(/^https:\/\/files\.mastodon\.social\//);
  });
});
```

(Adjust the top of the file: add `readFileSync`/`Parser` to the existing imports rather than duplicating `describe` imports — the snippet above shows the content, not final import layout.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run lib/feedParser.test.js`
Expected: FAIL — titles come out `'Untitled'`.

- [ ] **Step 4: Implement the fallback** — in `mapFeedItems` (`lib/feedParser.js`), replace the `title:` line:

```js
      const snippet = typeof item.contentSnippet === 'string' ? item.contentSnippet.trim() : '';
      mapped.push({
        id,
        title: item.title?.trim() || (snippet ? snippet.split('\n')[0].slice(0, 140) : 'Untitled'),
```

(`snippet` is declared inside the `try` before the `mapped.push`; everything else in the object literal stays as-is.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run lib/feedParser.test.js`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add lib/feedParser.js lib/feedParser.test.js lib/__fixtures__/
git commit -m "feat(parser): title fallback for title-less social posts + real bsky/mastodon fixtures"
```

---

### Task 5: feedService — alias resolution in POST and GET branches

**Files:**
- Modify: `lib/feedService.js` (lines 1-7 module head, 85-102 POST branch, 105-115 GET branch)
- Test: `lib/feedService.test.js` (append)

**Interfaces:**
- Consumes: `buildCatalogIndex` (Task 1).
- Produces: `getHeadlinesForSources(requestedSources, { category, deps })` and `getCatalogHeadlines({ category, source, deps })` — same signatures; `deps` additionally accepts `catalogIndex` and `catalog` for tests. Requested ids that are aliases resolve to canonical ids before the store query; unknown ids still classify as custom.

- [ ] **Step 1: Write the failing test** (append to `lib/feedService.test.js`, following the file's existing deps-injection pattern)

```js
import { buildCatalogIndex } from './catalogIndex.js';

describe('alias resolution (2D spec §5.1)', () => {
  const CATALOG = { sources: [{ id: 'new-slug', name: 'A', category: 'macro', aliases: ['old-slug'] }] };
  const IDX = buildCatalogIndex(CATALOG);

  function makeDeps(overrides = {}) {
    return {
      catalogIndex: IDX,
      catalog: CATALOG,
      storeIsWarm: async () => true,
      selectHeadlines: vi.fn(async () => []),
      fetchFeeds: vi.fn(async () => ({ headlines: [], stats: { total: 1, succeeded: 1, failed: 0 } })),
      ...overrides,
    };
  }

  it('POST: an aliased id resolves to canonical before the store query', async () => {
    const deps = makeDeps();
    await getHeadlinesForSources([{ id: 'old-slug' }], { deps });
    expect(deps.selectHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['new-slug'] })
    );
    expect(deps.fetchFeeds).not.toHaveBeenCalled();
  });

  it('POST: canonical and aliased ids do not double-query', async () => {
    const deps = makeDeps();
    await getHeadlinesForSources([{ id: 'old-slug' }, { id: 'new-slug' }], { deps });
    expect(deps.selectHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['new-slug'] })
    );
  });

  it('POST: an unknown id still routes to the live custom path', async () => {
    const deps = makeDeps();
    await getHeadlinesForSources([{ id: 'mystery', feedUrl: 'https://x.example/f' }], { deps });
    expect(deps.fetchFeeds).toHaveBeenCalled();
  });

  it('GET: ?source= through an alias serves the canonical source', async () => {
    const deps = makeDeps();
    await getCatalogHeadlines({ source: 'old-slug', deps });
    expect(deps.selectHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['new-slug'] })
    );
  });
});
```

(`getHeadlinesForSources`, `getCatalogHeadlines`, `vi`, `describe`, `it`, `expect` are already imported in this file; also call `resetFallbackForTests()` in a `beforeEach` if the surrounding file doesn't already — it does, follow its pattern.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/feedService.test.js`
Expected: FAIL — `old-slug` classifies as custom today.

- [ ] **Step 3: Implement** in `lib/feedService.js`:

Module head — replace the `catalogById` line:

```js
import { buildCatalogIndex } from './catalogIndex.js';
// ...
const catalog = require('./sources.json');
const defaultIndex = buildCatalogIndex(catalog);
```

`defaultDeps`:

```js
function defaultDeps(deps) {
  return { fetchFeeds: fetchAllFeeds, selectHeadlines, storeIsWarm, catalogIndex: defaultIndex, catalog, ...deps };
}
```

`liveFallback` — it filters `catalog.sources`; take the catalog from deps (add a third param `cat` and pass `d.catalog` from `readCatalog`; or simplest: change its signature to `liveFallback(sourceIds, category, d)` — it already is — and inside replace `catalog.sources` with `d.catalog.sources`).

POST branch classification (replace the `for` loop):

```js
  const catalogIds = [];
  const custom = [];
  for (const s of requestedSources) {
    const canonical = s && typeof s.id === 'string' ? d.catalogIndex.canonicalId(s.id) : null;
    if (canonical) {
      if (!catalogIds.includes(canonical)) catalogIds.push(canonical);
    } else {
      custom.push(s);
    }
  }
```

GET branch (replace the two filter lines):

```js
  let selected = d.catalog.sources;
  if (category) selected = selected.filter((s) => s.category === category);
  if (source) {
    const canonical = d.catalogIndex.canonicalId(source);
    selected = canonical ? selected.filter((s) => s.id === canonical) : [];
  }
```

- [ ] **Step 4: Run the full lib suite** (feedService has many existing tests)

Run: `npx vitest run lib/`
Expected: PASS, zero failures.

- [ ] **Step 5: Commit**

```bash
git add lib/feedService.js lib/feedService.test.js
git commit -m "feat(feeds): resolve slug aliases to canonical ids in POST and GET branches"
```

---

### Task 6: sourceKind helper + settingsStore (kind selectors, alias healing, news-only default)

**Files:**
- Create: `src/lib/sourceKind.js`
- Modify: `src/stores/settingsStore.js`
- Test: `src/stores/settingsStore.test.js` (create)

**Interfaces:**
- Consumes: `buildCatalogIndex` (Task 1).
- Produces: `sourceKind(source) → 'news'|'blog'|'social'` (from `src/lib/sourceKind.js`); settingsStore gains `getEffectiveSourcesByKind(kind) → source[]`; exports pure `healSelectedIds(ids, index?) → string[]` (same array reference when nothing changed). Default selection fallback = news-kind catalog ids only. Used by Tasks 7-12.

- [ ] **Step 1: Create the helper**

```js
// src/lib/sourceKind.js
// Absent kind ⇒ news: keeps the 10 pre-2D catalog entries and every
// pre-2D custom source in localStorage exactly where they live today.
export function sourceKind(source) {
  return source?.kind ?? 'news';
}
```

- [ ] **Step 2: Write the failing tests**

```js
// src/stores/settingsStore.test.js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildCatalogIndex } from '../../lib/catalogIndex';
import sourcesData from '../../lib/sources.json';
import useSettingsStore, { healSelectedIds } from './settingsStore';
import { sourceKind } from '../lib/sourceKind';

describe('healSelectedIds', () => {
  const IDX = buildCatalogIndex({ sources: [{ id: 'new-slug', aliases: ['old-slug'] }] });
  it('rewrites aliased ids to canonical, 1:1', () => {
    expect(healSelectedIds(['old-slug', 'other'], IDX)).toEqual(['new-slug', 'other']);
  });
  it('returns the same reference when nothing changed', () => {
    const ids = ['new-slug', 'other'];
    expect(healSelectedIds(ids, IDX)).toBe(ids);
  });
});

describe('kind-aware defaults and selectors', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('default selection (no localStorage) is news-kind catalog only', () => {
    useSettingsStore.getState().initFromStorage();
    const ids = useSettingsStore.getState().selectedSourceIds;
    const newsIds = sourcesData.sources.filter((s) => sourceKind(s) === 'news').map((s) => s.id);
    expect(ids).toEqual(newsIds);
  });

  it('getEffectiveSourcesByKind splits enabled sources by kind', () => {
    const blogId = sourcesData.sources.find((s) => s.kind === 'blog').id;
    const socialId = sourcesData.sources.find((s) => s.kind === 'social').id;
    useSettingsStore.setState({
      selectedSourceIds: ['daily-star', blogId, socialId],
      customSources: [],
    });
    const byKind = (k) => useSettingsStore.getState().getEffectiveSourcesByKind(k).map((s) => s.id);
    expect(byKind('news')).toEqual(['daily-star']);
    expect(byKind('blog')).toEqual([blogId]);
    expect(byKind('social')).toEqual([socialId]);
  });

  it('a custom source without kind counts as news', () => {
    useSettingsStore.setState({
      selectedSourceIds: ['custom-1'],
      customSources: [{ id: 'custom-1', name: 'X', category: 'custom' }],
    });
    expect(useSettingsStore.getState().getEffectiveSourcesByKind('news').map((s) => s.id)).toEqual(['custom-1']);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/stores/settingsStore.test.js`
Expected: FAIL — no `healSelectedIds` export, defaults include blogs/social.

- [ ] **Step 4: Implement in `src/stores/settingsStore.js`**

Add imports + index at the top:

```js
import { buildCatalogIndex } from '../../lib/catalogIndex';
import { sourceKind } from '../lib/sourceKind';

const catalogIndex = buildCatalogIndex(sourcesData);

// Exported pure for tests; heals stale ids after a catalog rename (2D §5.1).
export function healSelectedIds(ids, index = catalogIndex) {
  let changed = false;
  const healed = ids.map((id) => {
    const canonical = index.canonicalId(id);
    if (canonical && canonical !== id) {
      changed = true;
      return canonical;
    }
    return id;
  });
  return changed ? healed : ids;
}
```

Replace `loadSelectedSourceIds`:

```js
function loadSelectedSourceIds() {
  try {
    const stored = localStorage.getItem('masthead-selectedSources');
    if (stored) {
      const parsed = JSON.parse(stored);
      const healed = healSelectedIds(parsed);
      if (healed !== parsed) {
        localStorage.setItem('masthead-selectedSources', JSON.stringify(healed));
      }
      return healed;
    }
  } catch { /* ignore */ }
  // News only: blogs and social are opt-in surfaces (2D spec §4.4).
  return sourcesData.sources.filter((s) => sourceKind(s) === 'news').map((s) => s.id);
}
```

Add the selector to the store object (next to `getEffectiveSources`):

```js
  getEffectiveSourcesByKind: (kind) => {
    const { selectedSourceIds, customSources } = get();
    const idSet = new Set(selectedSourceIds);
    return [...sourcesData.sources, ...customSources].filter(
      (s) => sourceKind(s) === kind && idSet.has(s.id)
    );
  },
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/`
Expected: PASS (new suite + existing src tests untouched).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sourceKind.js src/stores/settingsStore.js src/stores/settingsStore.test.js
git commit -m "feat(settings): kind-aware selectors, alias healing, news-only default selection"
```

---

### Task 7: feedStore → factory with news + blogs instances

**Files:**
- Modify: `src/stores/feedStore.js` (full rewrite, same behaviors)
- Test: `src/stores/feedStore.test.js` (update mock + append)

**Interfaces:**
- Consumes: `getEffectiveSourcesByKind` (Task 6).
- Produces: `createFeedStore(selectRequest)`; `selectNewsRequest(settings, selectedCategory)` and `selectBlogsRequest(settings, selectedCategory)` both → `{ sources, category, fallbackToCatalog }`; named exports `useNewsFeedStore`, `useBlogsFeedStore`; **default export stays the news instance** (all existing importers keep working). Used by Tasks 8-10.

- [ ] **Step 1: Update the existing test's settingsStore mock** in `src/stores/feedStore.test.js` — the mock currently provides `getEffectiveSources`; the factory calls `getEffectiveSourcesByKind`:

```js
vi.mock('./settingsStore', () => ({
  default: { getState: () => ({ getEffectiveSourcesByKind: () => [] }) },
}));
```

- [ ] **Step 2: Append the new failing tests**

```js
import useFeedStore, { useBlogsFeedStore, selectNewsRequest, selectBlogsRequest } from './feedStore';

describe('store factory (2D spec §4.2)', () => {
  it('news and blogs instances hold independent state', () => {
    useFeedStore.setState({ selectedCategory: null });
    useBlogsFeedStore.setState({ selectedCategory: null });
    useBlogsFeedStore.getState().setCategory('economics');
    expect(useFeedStore.getState().selectedCategory).toBeNull();
    expect(useBlogsFeedStore.getState().selectedCategory).toBe('economics');
  });
});

describe('request selectors (2D spec §4.3)', () => {
  const settings = {
    getEffectiveSourcesByKind: (kind) => [{ id: `${kind}-1` }],
  };
  it('news mode requests news sources with the chip category', () => {
    expect(selectNewsRequest(settings, 'macro')).toEqual({
      sources: [{ id: 'news-1' }], category: 'macro', fallbackToCatalog: true,
    });
  });
  it('the social chip requests social sources with no category filter', () => {
    expect(selectNewsRequest(settings, 'social')).toEqual({
      sources: [{ id: 'social-1' }], category: null, fallbackToCatalog: false,
    });
  });
  it('blogs mode requests blog sources', () => {
    expect(selectBlogsRequest(settings, 'finance')).toEqual({
      sources: [{ id: 'blog-1' }], category: 'finance', fallbackToCatalog: false,
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/stores/feedStore.test.js`
Expected: FAIL — no factory exports.

- [ ] **Step 4: Rewrite `src/stores/feedStore.js`**

```js
import { create } from 'zustand';
import { fetchHeadlines, fetchHeadlinesWithSources } from '../lib/api';
import useSettingsStore from './settingsStore';

// One store per feed surface (2D spec §4.2): News and Blogs each keep their
// own headlines, category, and in-flight sequence guard.
export function createFeedStore(selectRequest) {
  let requestSeq = 0;
  return create((set, get) => ({
    headlines: [],
    isLoading: false,
    error: null,
    fetchedAt: null,
    selectedCategory: null,

    setCategory: (category) => {
      set({ selectedCategory: category });
    },

    fetchFeeds: async () => {
      const requestId = ++requestSeq;
      const { selectedCategory } = get();
      set({ isLoading: true, error: null });
      const applyIfLatest = (partial) => {
        if (requestId === requestSeq) set(partial);
      };
      try {
        const settings = useSettingsStore.getState();
        const { sources, category, fallbackToCatalog } = selectRequest(settings, selectedCategory);

        if (sources.length === 0 && !fallbackToCatalog) {
          // Kind-scoped surface with nothing enabled: an empty slice, not
          // the server's default catalog (2D spec §4.3).
          applyIfLatest({ headlines: [], fetchedAt: new Date().toISOString(), isLoading: false });
          return;
        }

        let data;
        if (sources.length > 0) {
          const sourcesPayload = sources.map((s) => ({
            id: s.id || s.source_id,
            name: s.name,
            shortName: s.shortName || s.short_name,
            url: s.url,
            feedUrl: s.feedUrl || s.feed_url,
            feedType: s.feedType || s.feed_type || 'rss',
            category: s.category,
            color: s.color,
            paywall: s.paywall || false,
          }));
          data = await fetchHeadlinesWithSources(sourcesPayload, { category });
        } else {
          data = await fetchHeadlines({ category });
        }

        applyIfLatest({
          headlines: data.headlines || [],
          fetchedAt: data.fetchedAt,
          isLoading: false,
        });
      } catch {
        applyIfLatest({ error: 'Could not refresh feeds', isLoading: false });
      }
    },

    refresh: async () => {
      return get().fetchFeeds();
    },
  }));
}

export const selectNewsRequest = (settings, selectedCategory) =>
  selectedCategory === 'social'
    ? { sources: settings.getEffectiveSourcesByKind('social'), category: null, fallbackToCatalog: false }
    : { sources: settings.getEffectiveSourcesByKind('news'), category: selectedCategory, fallbackToCatalog: true };

export const selectBlogsRequest = (settings, selectedCategory) => ({
  sources: settings.getEffectiveSourcesByKind('blog'),
  category: selectedCategory,
  fallbackToCatalog: false,
});

export const useNewsFeedStore = createFeedStore(selectNewsRequest);
export const useBlogsFeedStore = createFeedStore(selectBlogsRequest);

export default useNewsFeedStore;
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/stores/feedStore.test.js`
Expected: PASS (sequencing test + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/stores/feedStore.js src/stores/feedStore.test.js
git commit -m "feat(stores): feed store factory with independent news and blogs instances"
```

---

### Task 8: feedCategories helper + CategoryTabs becomes prop-driven

**Files:**
- Create: `src/lib/feedCategories.js`
- Test: `src/lib/feedCategories.test.js` (create)
- Modify: `src/components/CategoryTabs.jsx` (full rewrite — becomes dumb)

**Interfaces:**
- Consumes: `sourceKind` (Task 6).
- Produces: `newsTabCategories(activeSources) → [{id,label}]` (leads with `{id:null,label:'All'}`, ends with `{id:'social',label:'Social'}` always); `blogsTabCategories(activeSources) → [{id,label}]` (leads with All). `CategoryTabs({ categories, selected, onSelect })` — pure render. Used by Task 9's FeedLayout.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/feedCategories.test.js
import { describe, it, expect } from 'vitest';
import { newsTabCategories, blogsTabCategories } from './feedCategories';

const ACTIVE = [
  { id: 'n1', category: 'macro' },                      // kind absent ⇒ news
  { id: 'n2', category: 'tech', kind: 'news' },
  { id: 'b1', category: 'economics', kind: 'blog' },
  { id: 'b2', category: 'tech', kind: 'blog' },
  { id: 's1', category: 'macro', kind: 'social' },
];

describe('newsTabCategories', () => {
  const cats = newsTabCategories(ACTIVE);
  it('leads with All, ends with Social, news categories between', () => {
    expect(cats).toEqual([
      { id: null, label: 'All' },
      { id: 'macro', label: 'Macro' },
      { id: 'tech', label: 'Tech' },
      { id: 'social', label: 'Social' },
    ]);
  });
  it('shows the Social chip even with zero social sources active', () => {
    expect(newsTabCategories([{ id: 'n1', category: 'macro' }]).at(-1)).toEqual({ id: 'social', label: 'Social' });
  });
});

describe('blogsTabCategories', () => {
  it('derives only from blog-kind sources', () => {
    expect(blogsTabCategories(ACTIVE)).toEqual([
      { id: null, label: 'All' },
      { id: 'economics', label: 'Economics' },
      { id: 'tech', label: 'Tech' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/feedCategories.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// src/lib/feedCategories.js
import { sourceKind } from './sourceKind';

function deriveCategories(sources) {
  const seen = new Set();
  const cats = [];
  for (const src of sources) {
    const cat = src.category;
    if (cat && !seen.has(cat)) {
      seen.add(cat);
      cats.push({ id: cat, label: cat.charAt(0).toUpperCase() + cat.slice(1) });
    }
  }
  return cats;
}

const ALL = { id: null, label: 'All' };
// Always visible for discovery; empty state handles zero enabled (2D §4.3).
const SOCIAL = { id: 'social', label: 'Social' };

export function newsTabCategories(activeSources) {
  const news = activeSources.filter((s) => sourceKind(s) === 'news');
  return [ALL, ...deriveCategories(news), SOCIAL];
}

export function blogsTabCategories(activeSources) {
  const blogs = activeSources.filter((s) => sourceKind(s) === 'blog');
  return [ALL, ...deriveCategories(blogs)];
}
```

- [ ] **Step 4: Rewrite `src/components/CategoryTabs.jsx`** as a dumb component (JSX below is the current render block unchanged; only the derivation moves out):

```jsx
export default function CategoryTabs({ categories, selected, onSelect }) {
  return (
    <div
      className="px-4 overflow-x-auto no-scrollbar"
      style={{ backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--divider)' }}
    >
      <div className="flex gap-5 min-w-max">
        {categories.map((cat) => {
          const isActive = selected === cat.id;
          return (
            <button
              key={cat.id ?? 'all'}
              onClick={() => onSelect(cat.id)}
              className="pt-2.5 pb-2 text-sm font-ui font-medium whitespace-nowrap transition-colors"
              style={{
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {cat.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

(The `useMemo`/`useSettingsStore`/`sourcesData` imports go away. App.jsx still passes old props at this instant — Task 9 fixes the call site; run only the unit test here, the build gate comes after Task 9.)

- [ ] **Step 5: Run to verify** — `npx vitest run src/lib/feedCategories.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/feedCategories.js src/lib/feedCategories.test.js src/components/CategoryTabs.jsx
git commit -m "feat(ui): pure chip derivation with always-on Social chip; CategoryTabs prop-driven"
```

---

### Task 9: FeedLayout + `/blogs` route + 5th tab + picker empty state + linkOut cards

**Files:**
- Modify: `src/components/ui/Icon.jsx` (add one glyph)
- Modify: `src/components/BottomTabBar.jsx:4-9` (tabs array)
- Create: `src/pages/FeedLayout.jsx`
- Create: `src/components/SourcePickerEmptyState.jsx`
- Modify: `src/pages/FeedPage.jsx` (store + linkOut props)
- Modify: `src/components/HeadlineCard.jsx` (linkOut wrapper)
- Modify: `src/App.jsx` (routes; delete inline FeedLayout)

**Interfaces:**
- Consumes: `useNewsFeedStore`/`useBlogsFeedStore` (Task 7), `newsTabCategories`/`blogsTabCategories` (Task 8), `getEffectiveSourcesByKind` (Task 6), `sourceKind` (Task 6).
- Produces: `FeedLayout({ mode })` with `mode: 'news'|'blogs'`; `FeedPage({ store, linkOut })`; `HeadlineCard({ headline, variant, linkOut })`; `SourcePickerEmptyState({ kind, title, message })`. No component-render test harness exists (no @testing-library) — the gate for this task is `npm run build` + the Task 12 live drive, per house rule "UI changes need a real surface".

- [ ] **Step 1: Add the `blogs` glyph** to the `paths` object in `src/components/ui/Icon.jsx` (lucide book-open):

```jsx
  // BottomTabBar.jsx Blogs tab
  blogs: (
    <>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </>
  ),
```

- [ ] **Step 2: Add the tab** — in `src/components/BottomTabBar.jsx` replace the tabs array:

```jsx
const tabs = [
  { to: '/', label: 'Feed', icon: 'feed' },
  { to: '/blogs', label: 'Blogs', icon: 'blogs' },
  { to: '/favorites', label: 'Saved', icon: 'bookmark' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];
```

- [ ] **Step 3: Create `src/components/SourcePickerEmptyState.jsx`**

```jsx
import sourcesData from '../../lib/sources.json';
import useSettingsStore from '../stores/settingsStore';
import { sourceKind } from '../lib/sourceKind';
import SourceToggleRow from './SourceToggleRow';

// One-tap curated picker shown when a kind-scoped surface has no enabled
// sources (2D spec §4.4). Enabling any source swaps this for the feed.
export default function SourcePickerEmptyState({ kind, title, message }) {
  const selectedSourceIds = useSettingsStore((s) => s.selectedSourceIds);
  const toggleSource = useSettingsStore((s) => s.toggleSource);
  const catalog = sourcesData.sources.filter((s) => sourceKind(s) === kind);

  return (
    <div className="pb-2">
      <div className="px-4 pt-8 pb-4 text-center">
        <h3 className="font-display text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        <p className="font-ui text-sm" style={{ color: 'var(--text-secondary)' }}>
          {message}
        </p>
      </div>
      {catalog.map((src) => (
        <SourceToggleRow
          key={src.id}
          source={src}
          isEnabled={selectedSourceIds.includes(src.id)}
          onToggle={toggleSource}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: `src/components/HeadlineCard.jsx` — linkOut wrapper.** Add the prop and swap the hardcoded `Link` for a chosen wrapper. At the top of the component:

```jsx
export default function HeadlineCard({ headline, variant = 'compact', linkOut = false }) {
  const linkState = {
    url: headline.url,
    sourceId: headline.sourceId,
    sourceName: headline.sourceName,
    sourceShortName: headline.sourceShortName,
    sourceColor: headline.sourceColor,
  };
  // Social posts open the original (2D spec §4.6) — reader extraction on
  // bsky/mastodon post pages produces junk, an honest link-out beats it.
  const Wrapper = linkOut ? 'a' : Link;
  const wrapperProps = linkOut
    ? { href: headline.url, target: '_blank', rel: 'noopener noreferrer' }
    : { to: `/article/${headline.id}`, state: linkState };
```

Then in BOTH variants replace `<Link to={…} state={linkState}` with `<Wrapper {...wrapperProps}` and the closing `</Link>` with `</Wrapper>` (className/style props stay identical).

- [ ] **Step 5: `src/pages/FeedPage.jsx` — accept props** (replace the import of the default store):

```jsx
import useNewsFeedStore from '../stores/feedStore';
// ...
export default function FeedPage({ store = useNewsFeedStore, linkOut = false }) {
  const { headlines, isLoading, error, fetchFeeds, refresh } = store();
```

And pass `linkOut` down where cards render:

```jsx
          <HeadlineCard
            key={headline.id}
            headline={headline}
            variant={index === 0 ? 'lead' : 'compact'}
            linkOut={linkOut}
          />
```

- [ ] **Step 6: Create `src/pages/FeedLayout.jsx`** (moves + extends the inline layout from App.jsx):

```jsx
import { useEffect, useMemo } from 'react';
import TopBar from '../components/TopBar';
import CategoryTabs from '../components/CategoryTabs';
import FeedPage from './FeedPage';
import SourcePickerEmptyState from '../components/SourcePickerEmptyState';
import { useNewsFeedStore, useBlogsFeedStore } from '../stores/feedStore';
import useSettingsStore from '../stores/settingsStore';
import { newsTabCategories, blogsTabCategories } from '../lib/feedCategories';
import sourcesData from '../../lib/sources.json';

const MODES = {
  news: { store: useNewsFeedStore, tabs: newsTabCategories },
  blogs: { store: useBlogsFeedStore, tabs: blogsTabCategories },
};

export default function FeedLayout({ mode }) {
  const { store, tabs } = MODES[mode];
  const { fetchedAt, isLoading, selectedCategory, setCategory, refresh } = store();
  const selectedSourceIds = useSettingsStore((s) => s.selectedSourceIds);
  const customSources = useSettingsStore((s) => s.customSources);
  const getEffectiveSourcesByKind = useSettingsStore((s) => s.getEffectiveSourcesByKind);

  const categories = useMemo(() => {
    const idSet = new Set(selectedSourceIds);
    const active = [...sourcesData.sources, ...customSources].filter((s) => idSet.has(s.id));
    return tabs(active);
  }, [selectedSourceIds, customSources, tabs]);

  useEffect(() => {
    refresh();
  }, [selectedCategory]);

  const isSocialChip = mode === 'news' && selectedCategory === 'social';
  const pickerKind = mode === 'blogs' ? 'blog' : isSocialChip ? 'social' : null;
  const needsPicker = pickerKind && getEffectiveSourcesByKind(pickerKind).length === 0;

  return (
    <>
      <TopBar fetchedAt={fetchedAt} isLoading={isLoading} onRefresh={refresh} />
      <CategoryTabs categories={categories} selected={selectedCategory} onSelect={setCategory} />
      {needsPicker ? (
        <SourcePickerEmptyState
          kind={pickerKind}
          title={pickerKind === 'blog' ? 'Follow some blogs' : 'Follow social accounts'}
          message={
            pickerKind === 'blog'
              ? 'Pick a few blogs and newsletters to build this feed.'
              : 'Follow news outlets on Bluesky and Mastodon.'
          }
        />
      ) : (
        <FeedPage store={store} linkOut={isSocialChip} />
      )}
    </>
  );
}
```

- [ ] **Step 7: Slim `src/App.jsx`** — delete the inline `FeedLayout` function and its now-unused imports (`TopBar`, `CategoryTabs`, `useFeedStore`); add:

```jsx
import FeedLayout from './pages/FeedLayout';
```

and change the routes:

```jsx
            <Route path="/" element={<FeedLayout mode="news" />} />
            <Route path="/blogs" element={<FeedLayout mode="blogs" />} />
```

- [ ] **Step 8: Gate — full suite + build**

Run: `npm test` → all pass.
Run: `npm run build` → exit 0 (Vite + bundle guard). Lint: `npx eslint .` → exactly the 3 baseline errors, zero new. Note: the `useEffect(() => { refresh(); }, [selectedCategory])` pattern is carried over verbatim from the old App.jsx FeedLayout — if the lint baseline shifts because the code moved files, record the exact new count and location in the PR body; do not fix unrelated baseline errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/ui/Icon.jsx src/components/BottomTabBar.jsx src/pages/FeedLayout.jsx src/components/SourcePickerEmptyState.jsx src/pages/FeedPage.jsx src/components/HeadlineCard.jsx src/App.jsx
git commit -m "feat(ui): Blogs tab, Social chip surface, picker empty states, social link-out"
```

---

### Task 10: AddSourceModal — News/Blogs choice with auto-suggestion

**Files:**
- Create: `src/lib/suggestKind.js`
- Test: `src/lib/suggestKind.test.js` (create)
- Modify: `src/components/AddSourceModal.jsx`

**Interfaces:**
- Produces: `suggestKind(url) → 'blog'|'news'` (never throws). Custom sources emitted by the modal now carry `kind`.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/suggestKind.test.js
import { describe, it, expect } from 'vitest';
import { suggestKind } from './suggestKind';

describe('suggestKind (2D spec §4.5)', () => {
  it.each([
    ['https://stratechery.substack.com/feed', 'blog'],
    ['sub.example.beehiiv.com', 'blog'],
    ['https://medium.com/@someone', 'blog'],
    ['https://ghost.io/blog', 'blog'],
    ['https://buttondown.email/writer', 'blog'],
    ['https://reuters.com', 'news'],
    ['https://notsubstack.com', 'news'],
    ['', 'news'],
    ['not a url at all %%%', 'news'],
  ])('%s → %s', (input, expected) => {
    expect(suggestKind(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/suggestKind.test.js` → FAIL.

- [ ] **Step 3: Implement**

```js
// src/lib/suggestKind.js
const BLOG_HOST_SUFFIXES = ['substack.com', 'ghost.io', 'beehiiv.com', 'medium.com', 'buttondown.email'];

// Domain-based default for the Add Source modal (2D spec §4.5).
// Total function: any unparseable input just suggests 'news'.
export function suggestKind(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return 'news';
  try {
    const withScheme = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return BLOG_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`)) ? 'blog' : 'news';
  } catch {
    return 'news';
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/lib/suggestKind.test.js` → PASS.

- [ ] **Step 5: Wire the modal.** In `src/components/AddSourceModal.jsx`:

```jsx
import { suggestKind } from '../lib/suggestKind';
// state, next to category:
const [kind, setKind] = useState('news');
```

In `handleSearch`, after `setFeeds(result.feeds)`:

```jsx
        setKind(suggestKind(result.feeds[0].feedUrl || url.trim()));
```

In `handleAdd`, add `kind` to the emitted object (after `paywall: false`):

```jsx
      kind,
```

Add the chooser UI between the URL input block and the Category selector block:

```jsx
          {/* Appears in (2D spec §4.5) */}
          <div className="mb-4">
            <label className="font-ui text-xs font-medium mb-1 block" style={{ color: 'var(--text-tertiary)' }}>
              Appears in
            </label>
            <div className="flex gap-2">
              {[['news', 'News feed'], ['blog', 'Blogs & Newsletters']].map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setKind(value)}
                  className="flex-1 px-3 py-2 rounded-lg font-ui text-sm font-medium"
                  style={{
                    backgroundColor: kind === value ? 'var(--accent)' : 'var(--bg-surface)',
                    color: kind === value ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
```

- [ ] **Step 6: Gate + commit**

Run: `npm test` → PASS; `npm run build` → exit 0.

```bash
git add src/lib/suggestKind.js src/lib/suggestKind.test.js src/components/AddSourceModal.jsx
git commit -m "feat(ui): Add Source modal kind choice with domain auto-suggestion"
```

---

### Task 11: Onboarding stays news-only + Settings groups by kind

**Files:**
- Modify: `src/pages/OnboardingPage.jsx:7,11,44` (news filter)
- Modify: `src/pages/SettingsPage.jsx:73,137-151` (kind grouping)

**Interfaces:**
- Consumes: `sourceKind` (Task 6).
- Produces: onboarding never shows/enables/upserts blog or social sources; Settings shows three grouped sections.

- [ ] **Step 1: OnboardingPage.** Add the import and a filtered constant; replace all three uses of the full list:

```jsx
import { sourceKind } from '../lib/sourceKind';

// Onboarding is news-only (2D spec §4.4): blogs and social are opt-in
// in their own surfaces, never bulk-enabled at first run.
const NEWS_SOURCES = sourcesData.sources.filter((s) => sourceKind(s) === 'news');
const ALL_SOURCE_IDS = new Set(NEWS_SOURCES.map((s) => s.id));
```

- Line 44: `const rows = NEWS_SOURCES` (instead of `sourcesData.sources`) — the `.filter((s) => selectedIds.has(s.id))` chain stays.
- Line ~136: `<SourceSelectGrid sources={NEWS_SOURCES} …` (instead of `sourcesData.sources`).

- [ ] **Step 2: SettingsPage.** Replace the flat `allSources` list + single "News Sources" section with three sections. Replace `const allSources = [...sourcesData.sources, ...customSources];` with:

```jsx
  const allSources = [...sourcesData.sources, ...customSources];
  const sourceGroups = [
    ['News Sources', allSources.filter((s) => sourceKind(s) === 'news')],
    ['Blogs & Newsletters', allSources.filter((s) => sourceKind(s) === 'blog')],
    ['Social', allSources.filter((s) => sourceKind(s) === 'social')],
  ];
```

(plus `import { sourceKind } from '../lib/sourceKind';` at the top). Then replace the single `<SettingSection title="News Sources">…</SettingSection>` block with a map — keeping the row markup and the trailing "add source" button inside the LAST group only... **No — simpler and clearer:** render the three sections, and keep the existing add-source button in the first ("News Sources") section exactly where it is today, since the modal now chooses the kind itself:

```jsx
      {sourceGroups.map(([title, sources], gi) => (
        <SettingSection key={title} title={title}>
          <div>
            {sources.map((src) => {
              const isCustom = customSources.some((c) => c.id === src.id);
              return (
                <SourceToggleRow
                  key={src.id}
                  source={src}
                  isEnabled={selectedSourceIds.includes(src.id)}
                  onToggle={toggleSource}
                  onRemove={isCustom ? removeCustomSource : undefined}
                />
              );
            })}
            {gi === 0 && (
              /* existing "+ Add New Source" button block moves here verbatim */
            )}
          </div>
        </SettingSection>
      ))}
```

(The `{gi === 0 && (…)}` wraps the existing button JSX unchanged.)

- [ ] **Step 3: Gate + commit**

Run: `npm test` → PASS; `npm run build` → exit 0; `npx eslint .` → baseline only.

```bash
git add src/pages/OnboardingPage.jsx src/pages/SettingsPage.jsx
git commit -m "feat(ui): news-only onboarding; settings sources grouped by kind"
```

---

### Task 12: `scripts/verify-catalog.mjs` + full gates + live drive

**Files:**
- Create: `scripts/verify-catalog.mjs`
- Modify: `package.json` (one script line)

**Interfaces:**
- Produces: `npm run verify-catalog` — exits 0 only if every catalog feed returns HTTP 200 + XML + ≥1 item. Manual gate (NOT in CI — 36 network calls make a flaky gate, spec §8).

- [ ] **Step 1: Write the script**

```js
// scripts/verify-catalog.mjs
// Manual catalog health check (2D spec §8): every feedUrl must return
// HTTP 200, parseable-looking XML, and at least one item. Run before
// merge and paste the output into the PR. Deliberately NOT wired into
// CI or the build: 36 network calls make a flaky gate.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const catalog = require('../lib/sources.json');

const results = await Promise.all(
  catalog.sources.map(async (s) => {
    try {
      const res = await fetch(s.feedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.text();
      const isXml = /<\?xml|<rss|<feed/.test(body.slice(0, 300));
      const items = (body.match(/<item>|<entry[\s>]/g) || []).length;
      return { id: s.id, status: res.status, items, ok: res.status === 200 && isXml && items > 0 };
    } catch (err) {
      return { id: s.id, status: 'ERR', items: 0, ok: false, err: err.message };
    }
  })
);

for (const r of results) {
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${String(r.status).padStart(3)}  ${String(r.items).padStart(3)} items  ${r.id}${r.err ? `  (${r.err})` : ''}`
  );
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} feeds healthy`);
process.exit(failed.length > 0 ? 1 : 0);
```

Add to `package.json` scripts:

```json
    "verify-catalog": "node scripts/verify-catalog.mjs",
```

- [ ] **Step 2: Run it**

Run: `npm run verify-catalog`
Expected: `36/36 feeds healthy`, exit 0. (Any FAIL → strike or fix that entry in `lib/sources.json`, adjusting the Task 3 count assertions, and note it for the PR body. Verification is from this Mac (BD egress); the authoritative bom1 check is the post-deploy poll run — spec §6.5.)

- [ ] **Step 3: Full gates, uncut**

Run: `npm test` → expected: **~170+ tests, 0 failures, exit 0** (148 pre-slice + this slice's new suites). Cite exact count.
Run: `npm run build` → exit 0, bundle guard clean.
Run: `npx eslint .` → exactly the pre-existing baseline (3 errors), zero new warnings/errors introduced by 2D files.

- [ ] **Step 4: Live drive (house rule: UI needs a real surface)**

```bash
tmux new-session -d -s dev "npm run dev"
```

Playwright/browser checklist, BOTH themes (`documentElement.className='dark'`), 390px and 768px:
1. News tab unchanged: chips All/Bangladesh/Macro/Tech + Social; All shows no social posts.
2. Social chip, nothing enabled → picker; enable NPR 🦋 → posts render with real text titles (not "Untitled"); card click opens bsky.app in a new tab (no reader route).
3. Blogs tab first visit → picker; enable 2 blogs → feed renders; category chips (e.g. Economics) filter; a blog card opens the in-app reader with extracted body.
4. Add Source: paste a substack URL → "Blogs & Newsletters" preselected; add → appears in Blogs tab and its Settings group.
5. Settings: three grouped sections; toggles work; custom source removable.
6. Onboarding (fresh profile / cleared storage): grid shows news sources only.
7. Saved/History/Reader/share-target untouched: heart a blog article → appears in Saved.

- [ ] **Step 5: Commit + PR**

```bash
git add scripts/verify-catalog.mjs package.json
git commit -m "feat(catalog): manual 36-feed health check script"
```

Then follow the house `/ship` flow: push branch, open PR titled "Phase 2 · Slice 2D — blogs & newsletters + expanded catalog", body citing: exact test count + exit codes, verify-catalog output, live-drive checklist results, lint baseline note. **Pre-merge house process: spec red-team already done at spec stage; run the adversarial code review (Opus, countable verdicts) before merge approval. Merge only with per-action owner approval.**

Post-deploy proof (spec §10): measured poll run (all 36 attempted, failures enumerated), anon REST query showing blog+social rows, live drive on masthead-news.vercel.app, headers/PWA intact.

---

## Plan Self-Review Log

- **Spec coverage:** §3 data model → T3/T6; §4.1 nav → T9; §4.2 factory → T7; §4.3 selection → T7/T8/T9; §4.4 defaults/pickers → T6/T9/T11; §4.5 modal → T10; §4.6 link-out → T9; §5.1 aliases → T1/T5/T6; §5.2 at_* → T2; §5.3 polling → no code, T12 post-deploy proof; §6 slate → T3/T12; §8 tests → T1-T10; §10 rollout → T12. No gaps found.
- **Count correction applied inline (T3):** with the-rundown-ai reclassified, kind counts are 15 news / 15 blog / 6 social = 36.
- **Type consistency check:** `sourceKind` lives ONLY in `src/lib/sourceKind.js`; `buildCatalogIndex` returns `{byId, canonicalId, has}` used identically in T5/T6; selectors return `{sources, category, fallbackToCatalog}` in both T7 code and tests; `FeedLayout({mode})`, `FeedPage({store, linkOut})`, `HeadlineCard({headline, variant, linkOut})` consistent across T9.
