# Phase 2 Slice 2A — Reader Redesign Foundation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin Masthead's core reading loop in the calm, typography-first "Quiet Editorial" language via a reusable token + primitives layer, with zero functional regression and both themes intentional.

**Architecture:** Refine and extend the token layer that *already exists* in `src/styles/globals.css` (`:root` / `:root.dark`); keep the existing `.dark`-class theme mechanism (`settingsStore`). Add a small `src/components/ui/` primitives set and self-hosted fonts. Refactor the core reading loop (feed, reader, chrome) deeply onto tokens + primitives; apply tokens-only consistency everywhere else. No backend, store, data, or schema changes.

**Tech Stack:** React 19, Vite 6, Tailwind 3 (`darkMode: 'class'` + `@tailwindcss/typography`), CSS custom properties, Zustand, vitest. Visual verification via the `visual-verify` skill (Playwright CLI).

## Global Constraints

*Every task's requirements implicitly include these.*

- **Pure presentation.** No edits to `src/stores/*` logic, `src/lib/*`, `api/*`, `server.js`, `lib/*` (server), `supabase/*`, or IndexedDB schema. (Restyling a component's markup is fine; changing its data/handlers is not.)
- **Keep the theme mechanism.** Tailwind `darkMode: 'class'` + `.dark` on `<html>`, toggled by `settingsStore.setTheme`/`applyTheme`. Do **not** add `data-theme` or a new theme hook. Refine token *values* only.
- **Keep the styling pattern.** Tailwind utilities for layout + inline `style={{ color: 'var(--token)' }}` for themed color + Tailwind font utilities. Route color/space/type through the refined tokens and new primitives.
- **Accent = ink-blue** (`--accent` `#33568C` light / `#8DB0E4` dark; `--accent-soft` `#EAF0F8` / `#1E2A3B`) — chosen 2026-07-11, replacing the prior newspaper red. It is one token pair; do not hardcode the hue anywhere else.
- **Both themes AA**; `prefers-reduced-motion` honored; visible `:focus-visible` on every interactive element.
- **Unit suite stays green:** `npm test` = 68/68. Any red is a real regression (2A changes no logic).
- **No new runtime/build dependency without sign-off** (VISION). The only planned dep additions are the self-hosted font packages in Task 2 — gated in Prerequisites.
- **Commits:** Conventional Commits, imperative, **no `Co-Authored-By` lines**.
- **Visual gate:** the `visual-verify` skill screenshots the affected route(s) at **320 / 375 / 768 / 1024 / 1440**, in **both themes**, reviewed before the task's commit is considered done.

## Prerequisites (user sign-off before execution)

These are the VISION sign-off items bundled into "start 2A":

1. **Accent hue** — ✅ **decided: ink-blue** (`#33568C` / `#8DB0E4`), 2026-07-11.
2. **Font pairing swap** — replace Playfair Display / DM Sans / Source Serif 4 / JetBrains Mono with **Newsreader (serif) + Inter (UI)**, vendored via `@fontsource/newsreader` + `@fontsource/inter` (devDeps — dependency addition needs sign-off). Fallback: hand-vendor subset `woff2` under `public/fonts/` (no dep).
3. **General visual direction** — the mockup (feed + reader, "Quiet Editorial").

Render-level component tests are intentionally **not** added (would require `@testing-library/react`, another dep); primitives are verified through visual-verify + their use in refactored screens. The existing 68-test logic suite is the regression guard.

---

## Task 1: Extend token layer + refine palette

**Files:**
- Create: `src/styles/tokens.css`
- Modify: `src/styles/globals.css` (`:root` lines 5–25, `:root.dark` lines 27–38)
- Modify: `src/main.jsx` (import `tokens.css` before `globals.css`)

**Interfaces:**
- Produces: CSS custom properties consumed by every later task — colors (`--bg-primary`, `--bg-card`, `--bg-surface`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--accent`, `--accent-soft`, `--border`, `--divider`); scale (`--step-0..6`), space (`--space-1..8`), radii (`--r-sm/md/lg`), motion (`--dur-fast/normal`, `--ease-out`), shadow (`--shadow-1/2`).

- [ ] **Step 1: Create `src/styles/tokens.css`** (non-color tokens; color stays in globals.css for one theme source)

```css
:root {
  /* Type scale — clamp()-based, fixed */
  --step--1: clamp(0.78rem, 0.76rem + 0.10vw, 0.83rem);
  --step-0:  clamp(0.94rem, 0.92rem + 0.12vw, 1.00rem);
  --step-1:  clamp(1.06rem, 1.01rem + 0.24vw, 1.20rem);
  --step-2:  clamp(1.20rem, 1.10rem + 0.45vw, 1.50rem);
  --step-3:  clamp(1.42rem, 1.25rem + 0.80vw, 1.95rem);
  --step-4:  clamp(1.70rem, 1.40rem + 1.40vw, 2.60rem);
  --reader-body: 1.09rem;   /* article body size */

  /* Space (4px base) */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;

  /* Radii */
  --r-sm: 8px; --r-md: 12px; --r-lg: 18px;

  /* Motion — compositor-friendly only */
  --dur-fast: 150ms; --dur-normal: 260ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);

  /* Elevation */
  --shadow-1: 0 1px 2px rgba(32,29,24,.05);
  --shadow-2: 0 8px 24px rgba(32,29,24,.07);
}
:root.dark {
  --shadow-1: 0 1px 2px rgba(0,0,0,.30);
  --shadow-2: 0 10px 30px rgba(0,0,0,.35);
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur-normal: 0ms; }
}
```

- [ ] **Step 2: Refine `globals.css` `:root` palette** to the Quiet Editorial light values (keep the variable names; change values). Set:

```css
  --bg-primary: #FAF8F3;
  --bg-card: #FFFFFF;
  --bg-surface: #F3F0E9;
  --text-primary: #201D18;
  --text-secondary: #635C51;
  --text-tertiary: #938B7E;
  --accent: #33568C;        /* ink-blue (chosen 2026-07-11) */
  --accent-soft: #EAF0F8;
  --border: #E7E1D6;
  --divider: #EFEAE1;
  /* --font-* set in Task 2; keep --error/--success/--paywall-badge as-is */
```

- [ ] **Step 3: Refine `globals.css` `:root.dark` palette** to the dark values:

```css
  --bg-primary: #171613;
  --bg-card: #201E1B;
  --bg-surface: #262320;
  --text-primary: #EDE8DF;
  --text-secondary: #A69E90;
  --text-tertiary: #726B5F;
  --accent: #8DB0E4;        /* ink-blue dark (chosen 2026-07-11) */
  --accent-soft: #1E2A3B;
  --border: #2E2A25;
  --divider: #272320;
```

- [ ] **Step 4: Import tokens in `src/main.jsx`** before `globals.css` so tokens resolve first. Add `import './styles/tokens.css';` immediately above the existing `import './styles/globals.css';`.

- [ ] **Step 5: Verify build + no logic regression**

Run: `npm run build`
Expected: exit 0.
Run: `npm test`
Expected: `Test Files ... passed`, 68 passed, exit 0.

- [ ] **Step 6: Visual-verify the palette** — run the app (`npm run dev`), use the `visual-verify` skill to screenshot the Feed route at 320/768/1440 in both themes. Confirm warm-paper light + soft-charcoal dark render, accent is the chosen hue. (Layout will still be old; only colors shift here.)

- [ ] **Step 7: Commit**

```bash
git add src/styles/tokens.css src/styles/globals.css src/main.jsx
git commit -m "feat(2a): extend token layer and refine palette to Quiet Editorial"
```

---

## Task 2: Self-host the Inter + Newsreader pairing

**Files:**
- Create: `src/styles/typography.css`
- Modify: `index.html` (remove Google Fonts `<link>`s at lines 12–14; add preloads)
- Modify: `tailwind.config.js` (`fontFamily`, lines 7–12)
- Modify: `src/styles/globals.css` (`--font-*`, lines 21–24)
- Modify: `src/main.jsx` (import font css)
- Add: `@fontsource/inter`, `@fontsource/newsreader` (devDeps) — **per Prerequisite 2**

**Interfaces:**
- Produces: `--font-ui` (Inter), `--font-serif` (Newsreader) used by all screens; Tailwind `font-ui` / `font-serif` utilities. (Retire `font-display`/`font-body`/`font-mono` names OR alias `font-display`→serif to avoid touching every consumer; see Step 4.)

- [ ] **Step 1: Add the font packages**

Run: `npm install -D @fontsource/inter @fontsource/newsreader`
Expected: added to `devDependencies`; `npm test` still green afterward.

- [ ] **Step 2: Create `src/styles/typography.css`** importing the weights actually used (Inter 400/500/600; Newsreader 400/500 + 400 italic):

```css
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/newsreader/400.css';
@import '@fontsource/newsreader/500.css';
@import '@fontsource/newsreader/400-italic.css';
```

- [ ] **Step 3: Remove Google Fonts from `index.html`** — delete the three `<link>` lines (preconnect googleapis, preconnect gstatic, the `css2?family=...` stylesheet). Update `theme-color` meta to the new light paper `#FAF8F3`.

- [ ] **Step 4: Update `tailwind.config.js` `fontFamily`** so utilities point at the new pairing; alias the old `display`/`body` names to serif so existing `font-display`/`font-body` consumers keep working until refactored:

```js
      fontFamily: {
        ui: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['Newsreader', 'Iowan Old Style', 'Charter', 'Georgia', 'serif'],
        display: ['Newsreader', 'Georgia', 'serif'], // alias — retired as screens refactor
        body: ['Newsreader', 'Georgia', 'serif'],    // alias
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
```

- [ ] **Step 5: Update `globals.css` `--font-*`**

```css
  --font-ui: 'Inter', system-ui, sans-serif;
  --font-serif: 'Newsreader', 'Iowan Old Style', 'Charter', Georgia, serif;
  --font-display: var(--font-serif);
  --font-body: var(--font-serif);
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
```

- [ ] **Step 6: Import fonts in `src/main.jsx`** — add `import './styles/typography.css';` above `tokens.css`.

- [ ] **Step 7: Verify build + no regression**

Run: `npm run build` → exit 0.
Run: `npm test` → 68 passed, exit 0.

- [ ] **Step 8: Visual-verify type** — screenshot Feed + open one article; confirm Inter UI + Newsreader reading serif render (no fallback to Times). Both themes.

- [ ] **Step 9: Commit**

```bash
git add src/styles/typography.css index.html tailwind.config.js src/styles/globals.css src/main.jsx package.json package-lock.json
git commit -m "feat(2a): self-host Inter + Newsreader pairing, drop Google Fonts"
```

---

## Task 3: UI primitives (Surface, Button, Icon, Tag)

**Files:**
- Create: `src/components/ui/Surface.jsx`, `src/components/ui/Button.jsx`, `src/components/ui/Icon.jsx`, `src/components/ui/Tag.jsx`

**Interfaces:**
- Produces:
  - `<Surface as="div" raised className style>...` — token-styled container (bg-card, border, radius, optional shadow).
  - `<Button variant="primary|ghost|icon" as onClick aria-label>...` — focus-visible ring, active scale, token colors.
  - `<Icon name="search|settings|back|share|bookmark|refresh|chevron" size={20} />` — single source for inline SVGs used by chrome/reader.
  - `<Tag color sourceName meta>` — the source kicker (dot + uppercase label + optional `meta` text), replaces ad-hoc source rows.

- [ ] **Step 1: Create `Surface.jsx`**

```jsx
export default function Surface({ as: As = 'div', raised = false, className = '', style = {}, children, ...rest }) {
  return (
    <As
      className={className}
      style={{
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        boxShadow: raised ? 'var(--shadow-2)' : 'none',
        ...style,
      }}
      {...rest}
    >
      {children}
    </As>
  );
}
```

- [ ] **Step 2: Create `Button.jsx`** (focus-visible + reduced-motion safe)

```jsx
const base = {
  fontFamily: 'var(--font-ui)', fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
  borderRadius: '999px', transition: 'transform var(--dur-fast) var(--ease-out), background-color var(--dur-fast)',
};
const variants = {
  primary: { background: 'var(--accent)', color: '#fff', border: 'none', padding: '9px 16px' },
  ghost:   { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '8px 14px' },
  icon:    { background: 'transparent', color: 'var(--text-secondary)', border: 'none', width: 36, height: 36, justifyContent: 'center', padding: 0 },
};
export default function Button({ as: As = 'button', variant = 'ghost', className = '', style = {}, children, ...rest }) {
  return (
    <As className={`mh-btn ${className}`} style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {children}
    </As>
  );
}
```

Add to `globals.css`: `.mh-btn:active { transform: scale(.97); } .mh-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` and, under reduced-motion, `.mh-btn { transition: none; }`.

- [ ] **Step 3: Create `Icon.jsx`** — a `name → <svg>` map (copy the exact paths already used in `BottomTabBar`/`TopBar` so the icon set is unified; stroke `currentColor`, `width/height={size}`). Include at least: `back`, `search`, `settings`, `share`, `bookmark`, `refresh`, `chevron`.

- [ ] **Step 4: Create `Tag.jsx`** (source kicker; wraps the role `SourceBadge` played)

```jsx
export default function Tag({ color, sourceName, meta }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
      fontSize: 'var(--step--1)', letterSpacing: '.06em', textTransform: 'uppercase',
      fontWeight: 700, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)' }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: color || 'var(--accent)' }} />
      {sourceName}
      {meta && <span style={{ color: 'var(--text-tertiary)', fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>· {meta}</span>}
    </span>
  );
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build` → exit 0. Run: `npm test` → 68 passed.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/ src/styles/globals.css
git commit -m "feat(2a): add Surface, Button, Icon, Tag primitives"
```

---

## Task 4: Refactor chrome — TopBar + BottomTabBar

**Files:**
- Modify: `src/components/TopBar.jsx`, `src/components/BottomTabBar.jsx`, `src/components/RefreshButton.jsx`

**Behavior to preserve (verify each):** TopBar shows wordmark + `timeAgo(fetchedAt)` + refresh; `refresh-line` on load. BottomTabBar: 4 `NavLink`s (`/`, `/favorites`, `/history`, `/settings`), active state, `end` on `/`, safe-area insets.

> Refactor task — **read the current file first**; keep every prop, handler, route, and `NavLink` render-prop. Change only styling: route colors through tokens, use `Icon` for glyphs, `Button variant="icon"` for the refresh/actions, wordmark in `var(--font-serif)`. Do not reproduce the file blind.

- [ ] **Step 1:** Refactor `TopBar` — wordmark "Masthead" in serif (`var(--font-serif)`, not all-caps unless preferred), `var(--text-primary)`; meta in `--text-tertiary`; refresh via `Button variant="icon"` + `Icon name="refresh"`. Keep `sticky top-0 z-50 safe-top` and the `refresh-line`.
- [ ] **Step 2:** Refactor `BottomTabBar` — icons via `Icon`, active color `var(--accent)`, inactive `var(--text-tertiary)`, hairline top border, `safe-bottom`. Keep all 4 routes + active logic.
- [ ] **Step 3: Verify** — `npm run build` (0), `npm test` (68). Manual smoke: refresh spins/line shows; tabs navigate + highlight.
- [ ] **Step 4: Visual-verify** TopBar + BottomTabBar at 320/375/768/1024/1440, both themes.
- [ ] **Step 5: Commit** `git commit -m "feat(2a): restyle TopBar and BottomTabBar onto tokens + primitives"`

---

## Task 5: Refactor CategoryTabs + SkeletonCard

**Files:** Modify `src/components/CategoryTabs.jsx`, `src/components/SkeletonCard.jsx`

**Behavior to preserve:** CategoryTabs derives categories from `selectedSourceIds` + `customSources` (the `useMemo`), `onSelect(cat.id)`, horizontal scroll (`no-scrollbar`). SkeletonCard shimmer.

> Read first; keep the `useMemo` logic and `onSelect` contract untouched — restyle only.

- [ ] **Step 1:** CategoryTabs — active tab uses an underline-in-accent (Reeder-calm) or the existing pill, but through tokens (`--accent`, `--bg-surface`, `--text-secondary`); hairline bottom border via `--divider`.
- [ ] **Step 2:** SkeletonCard — match the new HeadlineCard rhythm (Task 6); keep the `.skeleton` shimmer (already token-driven).
- [ ] **Step 3: Verify** build 0, tests 68. **Visual-verify** both, both themes.
- [ ] **Step 4: Commit** `git commit -m "feat(2a): restyle CategoryTabs and SkeletonCard"`

---

## Task 6: Refactor the feed — HeadlineCard + FeedPage

**Files:** Modify `src/components/HeadlineCard.jsx`, `src/pages/FeedPage.jsx` (read FeedPage first), `src/components/SourceBadge.jsx`, `src/components/PaywallBadge.jsx`

**Behavior to preserve:** `HeadlineCard` is a `<Link>` to `/article/:id` carrying `state` (url, sourceId, sourceName, sourceShortName, sourceColor); thumbnail with `onError` hide; `timeAgo`; paywall badge. `FeedPage` list rendering, empty/error/loading states.

> Read `FeedPage.jsx` and `HeadlineCard.jsx` first. Keep the `Link`, its `state`, `line-clamp`, thumbnail `onError`, and paywall logic. Restyle only.

- [ ] **Step 1:** HeadlineCard — kicker via `Tag` (source dot + `sourceShortName`/name), headline in `var(--font-ui)` semibold `--step-1` (calm sans headline) OR serif per direction, meta row via `--text-tertiary` with `tabular-nums` for time; hairline divider via `--divider`; hover moves headline to `--accent`. Preserve thumbnail block + `onError`.
- [ ] **Step 2:** FeedPage — introduce a light editorial hierarchy: first item as a **lead** (larger serif headline + optional lead image + dek), the rest as the compact list (scale contrast = one of the required design qualities). Keep all data/states.
- [ ] **Step 3: Verify** build 0, tests 68. Smoke: tap a card → correct article opens with the right `state`.
- [ ] **Step 4: Visual-verify** the feed at 320/375/768/1024/1440, both themes (and both accents if the hue is still undecided).
- [ ] **Step 5: Commit** `git commit -m "feat(2a): restyle feed — HeadlineCard lead hierarchy + FeedPage"`

---

## Task 7: Refactor the reader — ReaderPage + reader.css

**Files:** Modify `src/pages/ReaderPage.jsx` (read first), `src/styles/reader.css`

**Behavior to preserve (critical):** the sanitized render — DOMPurify sanitize immediately before `dangerouslySetInnerHTML` (XSS fix from Phase 1) **must remain**; save/favorite action; history push on read; `useSwipeBack`; font-size from `settingsStore`. Do not alter extraction, sanitize, or sync calls.

> Read `ReaderPage.jsx` first. This screen carries the Phase-1 XSS fix — preserve the DOMPurify sanitize step exactly. Restyle only the surrounding chrome + typography.

- [ ] **Step 1:** ReaderPage chrome — top bar with `Button variant="icon"` + `Icon name="back"`, source label (`Tag`), share + save actions; a thin reading-progress bar in `--accent` (optional, compositor-only). Preserve back/save/gesture handlers.
- [ ] **Step 2:** `reader.css` — refine `.reader-body` to Newsreader (`var(--font-serif)`), `--reader-body` size, `line-height: 1.72`, measure via existing `max-width`; headings serif; blockquote border in `--accent`; links `--accent`. Keep the font-size override wiring from settings.
- [ ] **Step 3: Verify** build 0, tests 68. Smoke: open an article — renders sanitized (inject a `<script>`/`onerror` fixture URL locally and confirm it's stripped), serif body, save works, swipe-back works.
- [ ] **Step 4: Visual-verify** the reader at 320/375/768/1024/1440, both themes.
- [ ] **Step 5: Commit** `git commit -m "feat(2a): restyle ReaderPage + reader typography (sanitize preserved)"`

---

## Task 8: Tokens-only consistency pass — secondary screens

**Files:** Modify `src/pages/SettingsPage.jsx`, `src/pages/HistoryPage.jsx`, `src/pages/FavoritesPage.jsx`, `src/pages/OnboardingPage.jsx`, `src/components/AddSourceModal.jsx`, `src/components/SourceSelectGrid.jsx`, `src/components/HistoryCard.jsx`, `src/components/SavedArticleCard.jsx`, `src/components/EmptyState.jsx` (read each first)

**Goal:** visual consistency, **not** re-composition. These inherit the refined tokens/fonts automatically; make only the edits needed so nothing looks half-done (swap any hardcoded old colors to tokens, apply `Surface`/`Button` where trivial, restyle the Settings theme control). Layout stays.

- [ ] **Step 1:** Settings — restyle the existing System/Light/Dark control + font-size slider (`accent-slider` already token-driven) through primitives; no behavior change.
- [ ] **Step 2:** History/Favorites/Onboarding + cards/modals — replace any leftover hardcoded colors with tokens; apply `Surface`/`Tag` where it drops in cleanly.
- [ ] **Step 3 (opportunistic):** the 3 pre-existing `set-state-in-effect` lint errors live in `PageTransition`, `FavoritesPage`, `HistoryPage` — all touched here or in the app shell. If a component is being reworked anyway, fix its effect properly (guard/derive) so the lint baseline drops; otherwise leave it. Do not add behavior risk to chase lint.
- [ ] **Step 4: Verify** build 0, tests 68. `npx eslint src lib api server.js` — record error count (target: ≤ 3, ideally fewer; **zero new**).
- [ ] **Step 5: Visual-verify** Settings + History + Favorites + Onboarding, both themes.
- [ ] **Step 6: Commit** `git commit -m "feat(2a): apply Quiet Editorial tokens to secondary screens"`

---

## Task 9: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Build + tests + lint**

Run: `npm run build` → exit 0.
Run: `npm test` → 68 passed, exit 0.
Run: `npx eslint src lib api server.js` → record exit + error count; confirm **zero new** errors vs the 3-error baseline (note any of the 3 cleared).

- [ ] **Step 2: Visual regression sweep** — `visual-verify` on Feed, Reader, Settings at **320 / 375 / 768 / 1024 / 1440** × **both themes** (× both accents only if hue undecided). Review every screenshot for overflow, contrast, and coherence. The page body must never scroll sideways.

- [ ] **Step 3: Accessibility pass** — contrast AA on Feed + Reader both themes (every text/surface pair); keyboard-operate tabs/nav/cards/reader actions; confirm `:focus-visible` rings; toggle `prefers-reduced-motion` and confirm motion stops.

- [ ] **Step 4: Functional smoke (no regression)** on the dev server: feed loads → switch category → open article (sanitized, serif) → save/favorite → swipe-back → pull-to-refresh → Settings theme System/Light/Dark flips correctly → sign-out clears data (favorites/history gone, `sb-*` + `masthead-*` swept).

- [ ] **Step 5: Commit** any final fixes: `git commit -m "test(2a): verification sweep fixes"` (or skip if clean).

---

## Task 10: Ship

**Files:** none (release)

- [ ] **Step 1:** Push the branch: `git push -u origin feat/phase2-2a-redesign`.
- [ ] **Step 2:** Open the PR (neutral, public-repo-safe body describing the redesign + test plan). Use the `ship` skill.
- [ ] **Step 3:** `gh pr checks <n> --watch` → all green (Vercel preview).
- [ ] **Step 4:** **Preview-verify** — open the Vercel preview URL; confirm both themes, the reader, and that security headers/PWA still work on the deployed artifact.
- [ ] **Step 5:** Get explicit merge approval (AskUserQuestion, PR number + repo), then `gh pr merge <n> --squash`; sync main, delete branch.
- [ ] **Step 6:** **Deploy-verify live** on `masthead-news.vercel.app` (deploy ≠ merge): new design renders, both themes, PWA/service-worker functions, CSP + security headers intact.

---

## Self-Review (against the spec)

- **Spec coverage:** token layer (T1) ✓; self-hosted Inter+Newsreader (T2) ✓; primitives (T3) ✓; deep refactor of feed/reader/chrome (T4–T7) ✓; tokened-only secondary screens (T8) ✓; both-theme `.dark` mechanism kept (T1, global constraint) ✓; accent = red default, one token (T1) ✓; visual-verify 5 breakpoints × both themes (T6/7/9) ✓; a11y AA + reduced-motion (T9) ✓; unit suite 68 green (every task) ✓; zero functional regression + deploy-verify (T9/T10) ✓; CSP-tighten flagged not bundled (spec §2.9) ✓; lint opportunity (T8) ✓.
- **Placeholder scan:** refactor tasks (T4–T8) intentionally do not reproduce existing-file JSX — they instruct "read first, preserve behavior, restyle" because the files exist and must be preserved, not rewritten blind. New-file tasks (T1–T3) carry complete code.
- **Type/name consistency:** primitives (`Surface`, `Button`, `Icon`, `Tag`) defined in T3 and referenced by exact name in T4–T8; token names defined in T1/T2 used consistently downstream.
