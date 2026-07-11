# Vision

Masthead is a fast, private, free news reader — a clean reading surface over RSS and full-article extraction, local-first with optional Supabase sync. It should keep being effortless to read with, safe by default (SSRF / CORS / rate-limit / CSP / sanitiser guards intact), and privacy-respecting (local-first, consent-aware, no tracking) as features grow.

The rules below scope what AI agents and contributors can ship without explicit sign-off.

## Merge by Default

- Bug fixes with clear cause and bounded blast radius.
- Documentation, README, and code-comment fixes.
- New tests, including coverage for existing code.
- Small UI/UX tweaks that don't change layout, copy, or behavior materially.
- Logging and small observability additions — that do **not** log secrets or user content (see privacy below).
- Extensions to an existing `lib/` guard that follow its established shape (a new SSRF case, a new sanitiser allowlist entry), with tests.
- Internal refactors confined to a single module that keep the external surface and tests green.
- Dependency **patch**-version bumps — except the framework-level deps listed under Needs Sign-Off.

## Needs Sign-Off

- **New features** — any change to user-visible behavior beyond a bug fix.
- **Dependency additions** in `package.json`.
- **Dependency minor/major bumps**, and any bump of: React, React-DOM, Vite, `@supabase/supabase-js`, `react-router-dom`, `@upstash/ratelimit`, `@upstash/redis`, Zustand, `dompurify`, `sanitize-html`, `linkedom`.
- **Toolchain / runtime changes** (Node version, Vite major, the PWA plugin).
- **Broad refactors** spanning >1 module or touching a public boundary — the `lib/` guard APIs, the `api/` handler contract, the `feedParser` `{ headlines, stats }` shape, the IndexedDB schema.
- **Architectural changes** — new root dirs, new build steps, new long-running processes, or adding CI.
- **Security-critical config** — CSP and security headers in `vercel.json`; the rate limiter's fail-open posture; the SSRF and CORS allowlists.
- **Supabase migrations, RLS policies, grants** — anything touching the prod database.
- **Privacy-impacting changes** — telemetry, new network destinations, what's stored in IndexedDB or Supabase, log content, auth/session handling.
- **Prod env values** — `ALLOWED_ORIGINS`, `SAVE_URL_TOKEN`, Upstash/Supabase keys.
- **Public-repo exposure** — anything that would publish an open-vulnerability narrative in commits, PRs, or issues.

## When in doubt

If a change could conceivably surprise the user, ask first. Cost of one extra question << cost of one bad surprise. This is a public, production reading app — security and privacy regressions are the expensive kind.
