# Agent Learning Rulebook — Masthead

A running log of lessons learned the hard way while shipping Masthead.

Different from `AGENTS.md` — that file documents **stable conventions and landmines** (the codebase is structured this way; don't break it). This file documents **incidents and lessons** (this is what went wrong, and here's how to prevent recurrence).

**Author:** AI agents under Adnan's direction. Appended on every incident; entries are point-in-time observations that may go stale but the lesson stays.

## How to add an entry

When something ships broken, when a methodology gap is exposed, or when a smoke test catches a real bug:

1. Write the entry below using the template.
2. If the lesson generalizes across Adnan's other projects, also append to the global rulebook at `~/.claude/AGENT_LEARNINGS.md`.
3. Save to AI auto-memory at `~/.claude/projects/-Users-adnanrashid-Projects-masthead/memory/` so future Claude sessions inherit.
4. If the lesson is a stable codebase rule, distill into a numbered `AGENTS.md` landmine.

## Entry template

```markdown
## YYYY-MM-DD — vX.Y.Z | Short title

**Trigger:** what surfaced the issue.

**What went wrong:** root cause in plain English; cite file:line if useful.

**Lesson:** the generalizable rule in one sentence.

**Prevention:** concrete steps (validator, smoke checklist, CI gate).

**Hotfix:** what shipped to resolve.

**Cross-references:** AGENTS.md landmine, auto-memory key, global rulebook entry.
```

---

## Entries (most recent first)

## 2026-07-11 — Phase 1 Harden | Sign-out left the Supabase JWT under `sb-*` keys

**Trigger:** Opus adversarial review of the sign-out / `clearUserData` task during the Harden build.

**What went wrong:** `clearUserData` swept only `masthead-*` localStorage keys, but `@supabase/supabase-js` stores its auth token under `sb-*` keys. When `signOut()` failed on the network, the JWT survived the clear — so the next visitor on a shared device had the previous user's session silently auto-restored on load.

**Lesson:** When clearing auth/session state, enumerate every storage prefix the auth library actually writes, not just your app's prefix. "I cleared my keys" ≠ "the session is gone."

**Prevention:** `clearUserData` now sweeps both `masthead-*` and `sb-*`; a load-bearing regression test asserts the `sb-*` token is `null` after clear (RED-confirmed failing before the fix).

**Hotfix:** Shipped in PR #1 (squash `b2e008a`).

**Cross-references:** AGENTS.md landmine #4; auto-memory `masthead-harden-shipped`.

---

## 2026-07-11 — Phase 1 Harden | Postgres revoke-from-roles was a no-op while PUBLIC held the grant

**Trigger:** Opus review of the `handle_new_user()` privilege-revoke migration, plus a live `has_function_privilege` check.

**What went wrong:** The migration revoked `EXECUTE` from `anon` and `authenticated`, but Postgres grants `EXECUTE` to `PUBLIC` by default when a function is created. Revoking from named roles while the `PUBLIC` grant stands is a no-op — `has_function_privilege('anon', ...)` still returned true. The "hole closed" claim rested on a green migration, not a verified privilege.

**Lesson:** A green migration is not a closed hole. For Postgres privilege changes, revoke from `PUBLIC` (not only named roles) and verify the actual privilege with `has_function_privilege` / the function ACL — never "the migration applied cleanly."

**Prevention:** Migration now does `revoke ... from public, anon, authenticated`; verified the ACL reduced to `{postgres, service_role}` and the Supabase security advisor returns 0 warnings.

**Hotfix:** Corrected `supabase/migrations/20260711_revoke_handle_new_user.sql`, re-applied to prod.

**Cross-references:** AGENTS.md landmine #5; auto-memory `postgres-revoke-public-gotcha`.

---

## 2026-07-11 — Phase 1 Harden | PR body narrated open prod vulnerabilities on a PUBLIC repo

**Trigger:** `gh pr create` for PR #1 was blocked; the body described the live holes the hardening was closing, including an exploitation window ("hole open until this deploys"), on a public GitHub repo.

**What went wrong:** Framing hardening in terms of currently-open production vulnerabilities publishes a roadmap for attackers during the exact window the app is exposed.

**Lesson:** On a public repo, describe hardening by what it adds and enforces — never by the live exposure it closes, and never with a timeline of when prod is vulnerable.

**Prevention:** Neutral public-repo disclosure convention (AGENTS.md landmine #10). PR body rewritten to describe the guards, not the holes → published.

**Hotfix:** Reworded PR #1 body.

**Cross-references:** AGENTS.md landmine #10.
