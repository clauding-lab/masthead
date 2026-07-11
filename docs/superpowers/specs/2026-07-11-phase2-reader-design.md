# Masthead Phase 2 — Reader: Design Spec

**Date:** 2026-07-11
**Status:** Phase 2 slicing approved (redesign-first); **Slice 2A designed in detail** below. Slices 2B–2E are sequenced stubs that each get their own spec → plan → PR when they start.
**Owner:** Adnan (product) / AI agents (implementation)
**Parent:** `docs/superpowers/specs/2026-07-11-public-masthead-design.md` (§4 roadmap, §2 decisions log). This spec expands that roadmap's Phase 2 into shippable slices.
**Visual reference:** Slice 2A direction mockup — "Quiet Editorial" (feed + reader, both themes). Published privately during the 2026-07-11 brainstorm.

---

## 1. Why Phase 2 is sliced, not built in one PR

The parent spec lists **seven** Phase 2 workstreams: the redesign, a Blogs & Newsletters section, server-side article storage + polling, read-it-later, premium subscriber feeds, an expanded catalog (incl. Bluesky/Mastodon), and bookmarklet capture. That is far too much for one spec, one plan, or one PR. A solo builder directing AI agents needs each step to end in a **shippable, cost-capped** state.

So Phase 2 is decomposed into a sequence of slices, each its own spec → plan → PR. Two rules govern the sequence:

1. **The app stays coherent after every slice.** Masthead is live and public; we never ship a half-reskinned or half-migrated app.
2. **Foundations before features.** A slice that others depend on lands before its dependents.

### 1.1 The slices (dependency order)

| Slice | Name | Depends on | Ships |
| --- | --- | --- | --- |
| **2A** | **Reader redesign foundation** | — | A visibly better app; the design system + primitives every later slice reuses. No backend, no cost. |
| **2B** | Server-side article storage + polling | 2A (UI language) | Feeds served from our own store via a scheduled poller, with retention/pruning. The load-bearing infra for 2C–2E and Phase 3. First slice with real (capped) running cost. |
| **2C** | Read-it-later + bookmarklet | 2B (storage) | Save any URL / share-into-app / bookmarklet; revives the dead `save-url` subsystem to actually persist. |
| **2D** | Blogs & Newsletters + expanded catalog | 2A, 2B | The dedicated Blogs & Newsletters section; curated catalog incl. Bluesky/Mastodon native RSS. |
| **2E** | Premium subscriber feeds | 2B | Secret-bearing per-user feed URLs folded into the poller, with careful secret handling. Last: trickiest security, lowest frequency. |

**This spec designs Slice 2A.** 2B–2E are stubbed in §4 and get full specs when they start.

---

## 2. Slice 2A — Reader redesign foundation (detailed design)

### 2.1 Goal

Replace Masthead's current styling with a deliberate, calm, typography-first design language — **"Quiet Editorial"** (Reeder/Things DNA) — realised as a reusable **design-token + primitives layer**, and applied deeply to the core reading loop. The app must look and feel intentional in both light and dark, with **zero functional regression** for a normal reader.

### 2.2 Scope: where effort concentrates

Masthead must be coherent after 2A, so the new tokens apply app-wide. But *deliberate re-composition* is concentrated where it matters and where later slices won't immediately rework it:

- **Deep redesign (re-composed):** Feed list (`FeedPage`, `HeadlineCard`, `CategoryTabs`, `SkeletonCard`), the article reader (`ReaderPage`), and chrome (`TopBar`, `BottomTabBar`).
- **Tokened only (consistent, not re-laid-out):** `SettingsPage`, `HistoryPage`, `FavoritesPage`, `OnboardingPage`, and the modals (`AddSourceModal`, `SourceSelectGrid`, etc.). They inherit the new colors, type, spacing, and primitives so nothing looks broken — but their layouts are left for the slices that touch them anyway (2C touches Saved/History; 2D touches source management).

**Rationale:** re-composing every screen now is rework, because 2C and 2D will restructure several of them. YAGNI.

### 2.3 Visual direction — "Quiet Editorial"

Paper over screen; one restrained accent; two typefaces doing distinct jobs. Both themes are *designed*, not inverted. Light is the default.

**Palette** (source values from the approved mockup; the token file may express them in OKLCH per the web coding-style rules). Neutrals are warm-biased toward paper, not pure grey.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--paper` | `#FAF8F3` | `#171613` | app background |
| `--surface` | `#FFFFFF` | `#201E1B` | cards / raised |
| `--surface-2` | `#F3F0E9` | `#262320` | inset / thumbs |
| `--ink` | `#201D18` | `#EDE8DF` | primary text |
| `--ink-2` | `#635C51` | `#A69E90` | secondary text |
| `--ink-3` | `#938B7E` | `#726B5F` | muted / meta |
| `--hairline` | `#E7E1D6` | `#2E2A25` | dividers / borders |
| `--accent` | `#C2452D` | `#E8634A` | links, active state — **newspaper red, Masthead's current identity, kept.** Ink-blue (`#33568C` / `#8DB0E4`) is the documented alternative shown in the mockup; final hue is the user's call. |
| `--accent-soft` | `#FFF0ED` | `#2A1A16` | accent-tint backgrounds |

Subtle per-source scannability dots (muted brand-adjacent hues) are decorative identity, **kept distinct from `--accent`**, which is reserved for interactive/active state. Semantic colors (error/success) are separate again and do not use the accent hue.

**Typography — two roles, self-hosted:**

- **UI / sans — Inter:** wordmark aside, drives nav, headlines-in-list, labels, meta. Weights 400/500/600.
- **Reading / serif — Newsreader:** the article body and the "Masthead" wordmark. A literary serif is what makes the app *feel* like a place to read. Weights 400/500 (+ 400 italic for pull-quotes).
- Self-host both via `@font-face`, latin-subset, `font-display: swap`; preload only the critical weights (Inter 400/600, Newsreader 400). Two families, no more.
- Type scale is `clamp()`-based and fixed; article body ~1.09rem at `line-height: 1.7`; headings get `text-wrap: balance`.

**Motion:** compositor-only (`transform`/`opacity`); `prefers-reduced-motion` honored everywhere. Keep the existing gestures — `PullToRefresh`, `useSwipeBack`, `PageTransition`. Add only subtle, purposeful transitions (list rise on load, hover/active on interactive elements). No decorative motion.

**Themes:** keep the app's **existing mechanism** — Tailwind `darkMode: 'class'` + a `.dark` class on `<html>`, toggled by `settingsStore` (`setTheme`/`applyTheme`), which already supports System/Light/Dark and persists to `localStorage['masthead-theme']` (current default: Light). The redesign **refines the token values** in `globals.css` (`:root` and `:root.dark`); it does **not** introduce a competing `data-theme` scheme or a new theme hook. Components are styled **through tokens only**. (Changing the default from Light to System is a UX change — out of scope for 2A, flagged for the user.)

### 2.4 Architecture — the foundation

The point of 2A is that later slices inherit a system instead of re-inventing one. Masthead **already** has a token layer (CSS custom properties in `globals.css` `:root`/`:root.dark`) and a theme system (`settingsStore`). 2A **refines and extends** these — it does not start from scratch.

Current styling pattern (keep it — it is the codebase convention): **Tailwind utilities for layout** (`flex`, `gap`, `px-4`) + **inline `style={{ color: 'var(--token)' }}` for themed color** + Tailwind font utilities (`font-display`/`font-ui`). The refactor keeps this shape and routes color/spacing/type through the refined tokens and the new primitives.

```
src/styles/
  tokens.css        NEW — extend the token set: type scale, spacing, radii, motion, shadow
                    (color tokens stay in globals.css so there is ONE theme source)
  globals.css       EDIT — refine :root / :root.dark palette to "Quiet Editorial" values;
                    consume tokens; keep the .dark mechanism
  typography.css    NEW — @font-face for self-hosted Inter + Newsreader; base type rules
  reader.css        EDIT — serif reading rules via tokens (already serif; refine)
src/components/ui/  NEW — small primitives consumed by the refactored screens:
  Surface.jsx         card/raised container (border, radius, shadow via tokens)
  Button.jsx          variants: primary / ghost / icon; focus-visible; active state
  Tag.jsx             the source "kicker" (dot + uppercase source label); may wrap/replace SourceBadge
  Icon.jsx            thin wrapper over the inline SVG set (single source of truth)
tailwind.config.js  EDIT — fontFamily → Inter (ui) + Newsreader (serif); map theme colors to the
                    CSS vars so Tailwind utilities and inline styles agree (resolves today's
                    duplication — the palette currently lives in BOTH tailwind.config.js and
                    globals.css; CSS vars become the single source of truth)
```

**No new theme hook or toggle component:** `settingsStore` already owns System/Light/Dark and the Settings screen already has the control — 2A just restyles it. Then refactor the deep-redesign components onto tokens + primitives; tokened-only screens inherit from the cascade with minimal edits.

**Fonts:** today `index.html` loads DM Sans / Playfair Display / Source Serif 4 / JetBrains Mono from Google Fonts. 2A replaces the pairing with **Inter (UI) + Newsreader (serif)**, vendored under `public/fonts/` (stable path so `index.html` can `<link rel="preload">` the critical weights; the PWA service-worker precache must include them), latin-subset. Because we self-host, `vercel.json`'s CSP no longer needs `fonts.googleapis.com` / `fonts.gstatic.com`. Tightening the CSP to drop them is a small security win **but a CSP edit → needs sign-off (AGENTS landmine #6 / VISION)**; tracked as an optional follow-up in §2.9, not silently bundled.

### 2.5 Data flow

**None new.** 2A is pure presentation — no changes to `src/stores/*`, `src/lib/*`, `api/*`, `server.js`, `lib/*`, or the database. This is deliberate: it keeps the slice low-risk and makes visual regression the primary gate. Feed data, article extraction, auth, sync, and gestures behave exactly as before.

### 2.6 Accessibility

- Contrast **AA** verified on both themes for every text-on-surface pairing (the palette above is chosen to pass; verify, don't assume).
- Visible `:focus-visible` ring (accent) on every interactive element.
- Keyboard operable: tabs, nav, cards, reader actions.
- `prefers-reduced-motion: reduce` removes non-essential motion.
- Respect the OS theme by default; the manual toggle is an override, not a requirement.

### 2.7 Testing

Per the web testing rules, visual regression carries the signal for a redesign; unit tests guard the no-logic-change promise.

- **Visual verification** via the `visual-verify` skill (Playwright CLI — dev-time tool, not a new project dependency): screenshot Feed, Reader, and one tokened screen (Settings) at **320 / 375 / 768 / 1024 / 1440**, in **both themes**. Reviewed before merge. (A committed visual-regression CI harness would add a dependency → deferred as a sign-off decision, not part of 2A.)
- **Accessibility pass:** automated contrast + axe check on Feed and Reader, both themes; manual keyboard + reduced-motion check.
- **Unit suite unchanged:** `npm test` stays green (68 tests). Because 2A changes no logic, any red is a real regression. No new unit tests are required for pure styling; if a component's structure is refactored enough to warrant a render smoke test, add one.

### 2.8 Verification — definition of done

1. `npm run build` exit 0; `npm test` 68/68 (cite exit codes, no output filtering).
2. Lint adds **zero** new errors over the known 3-error baseline. *(Opportunity: `PageTransition`, `FavoritesPage`, `HistoryPage` — the 3 pre-existing `set-state-in-effect` errors — are all in files 2A touches; fixing them properly, with a guard, is an optional in-slice cleanup that would clear the baseline. Fix only if the component is being reworked anyway; otherwise leave per AGENTS.)
3. Visual verification screenshots (5 breakpoints × 2 themes × core screens) captured and reviewed.
4. Accessibility pass clean (contrast AA both themes; keyboard; reduced-motion).
5. **Zero functional/behavioral regression**, checked on the dev server: feed loads → category switch → article opens (sanitized, serif) → save/favorite → swipe-back → pull-to-refresh → sign-out clears data.
6. **Deploy verified live** (deploy ≠ merge): on `masthead-news.vercel.app`, confirm the new design renders, both themes work, the PWA/service worker still functions, and security headers are intact.

### 2.9 Out of scope for 2A

- Any backend, storage, polling, or database change (that is 2B).
- New features or new screens (read-it-later, newsletters, premium feeds, catalog expansion — later slices).
- Re-composing the tokened-only screens' layouts.
- The CSP tightening to drop Google Fonts origins (recommended follow-up; requires sign-off because it edits `vercel.json` security headers).
- A committed visual-regression CI harness (dependency decision for a later slice).

---

## 3. Slice 2A success criteria

- "Quiet Editorial" applied deeply to Feed + Reader + chrome; both themes intentional; light default.
- Reusable token + primitives layer in place, consumed by the refactored core screens.
- Every other screen visually consistent (tokened), nothing looks half-done.
- Zero functional/behavioral regression for a normal reader; unit suite green; build green.
- Accessibility AA on both themes; reduced-motion honored.
- Deployed artifact verified live.

---

## 4. Slices 2B–2E (sequenced stubs — own specs when they start)

### 4.1 Slice 2B — Server-side article storage + polling
Replace fetch-live-on-request with a store-and-serve model: Supabase tables for stored articles keyed per source/user; a Vercel Cron job that polls each active feed on a cadence, parses via the existing `lib/feedParser`/`lib/extractor`, and upserts; a **retention/pruning policy** so storage can't grow unbounded (a review finding). Feed reads switch to the store (faster, offline-capable). **Open questions for its spec:** exact schema + indexes; poll cadence and fan-out cost caps; per-user vs global source polling; dedup/pruning rules; Cron limits on the current Vercel plan; backfill/migration from today's live model. Pull the current Supabase schema (`list_tables`) at spec time.

### 4.2 Slice 2C — Read-it-later + bookmarklet
Revive `api/save-url` to **persist** (today it extracts and returns without storing). Add paste-a-URL, a PWA **Web Share Target**, and a bookmarklet that saves the rendered article from the user's own logged-in tab (covers paywalled pages without subscriber feeds). Stored via 2B. **Open questions:** library data model + sync; Share Target manifest; bookmarklet auth/size limits; dedup with feed items.

### 4.3 Slice 2D — Blogs & Newsletters + expanded catalog
A dedicated Blogs & Newsletters section distinct from the news feed (RSS covers most blogs + Substack/Ghost/beehiiv). Expand the curated `lib/sources.json` registry, including Bluesky (`bsky.app/profile/<handle>/rss`) and Mastodon (`<instance>/@user.rss`) accounts of major outlets. Built in the 2A language, fed by 2B. **Open questions:** section IA + navigation; source categorization model; catalog curation + governance.

### 4.4 Slice 2E — Premium subscriber feeds
Per-user secret-bearing feed URLs (e.g. a subscriber full-text RSS): stored per-user, **never shown in full, never shared into the public catalog**, folded into 2B's poller with secret handling (encryption at rest, redaction in UI/logs). Last because it is the highest-risk. **Never** store publisher credentials or scrape behind paywalls server-side (parent spec §6). **Open questions:** secret storage + encryption; poller integration without leaking secrets to logs; UI redaction.

---

## 5. Open items carried forward

- 2B spec: article-storage schema, poll cadence + cost caps, pruning/retention, Vercel Cron limits, migration from live-fetch.
- CSP tightening (drop Google Fonts origins) once fonts are self-hosted — needs sign-off.
- Whether to adopt a committed visual-regression CI harness (adds a dependency).
- The 3 pre-existing `set-state-in-effect` lint errors — clear opportunistically during 2A if their components are reworked.
- Fixing/curating source-name display for social feeds (Bluesky/Mastodon handles) — 2D.
