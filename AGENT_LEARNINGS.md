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

## 2026-08-01 — Phase 3 · 3A final-review fix wave | BEFORE-row trigger ordering and a missing-From guard both fed the same "infinite retry" failure class

**Trigger:** Whole-branch final review (Opus) of `feat/phase3-email-ingestion`, 31 commits, no per-task review had caught either issue because each was invisible from inside a single task's diff.

**What went wrong:** Two independent bugs converged on the same consequence — a deterministically bad message getting deferred forever instead of bounced. (1) `enforce_inbox_quota` (`supabase/migrations/20260731_create_inbox.sql`) is a BEFORE-row trigger; Postgres fires those before checking constraints, so a redelivered message whose `(user_id, dedupe_key)` already existed hit the quota count/raise FIRST when the inbox was full — a stored duplicate at quota returned `over_quota_final`/507 (permanent NDR) instead of `duplicate`, silently violating spec §5.1's stated ordering. The unit test for this ordering (`inboxIngest.test.js` case 15) could not catch it — it mocks `insertMessage`, so it pins that the APP never independently queries quota, not that the DB's trigger/constraint race resolves correctly; only a live-DB probe can. (2) `parseEmail` returns `fromEmail: null` for real shapes (no From header, `undisclosed-recipients:;`, an empty `<>`) and `from_email` is `NOT NULL` at the DB — the row failed insert with 23502, surfaced as a 500, and the Cloudflare Worker's defer-on-non-2xx logic retried it forever, since nothing about a missing From header is ever going to resolve on retry.

**Lesson:** for any BEFORE-row trigger enforcing an ordered check (spec says "A precedes B"), verify the ordering against Postgres's OWN trigger-fires-before-constraints semantics, not against the app-level call sequence — and write the enforcing test as a live-DB probe, not a mock, since the mock cannot see trigger execution order. Separately: any pipeline stage that maps parser output straight into a NOT NULL column needs an explicit null-guard mapped to a permanent (4xx) verdict, not just a happy-path type — a NOT NULL violation reaching the caller as a raw 500 gets treated as transient and retried forever against mail that will never become valid.

**Prevention:** `enforce_inbox_quota` short-circuits with `return new` when `(user_id, dedupe_key)` already exists, before the quota count runs — verified live by a new dedupe-precedes-quota block in `scripts/probe-inbox-custody.mjs` (asserts PostgREST 409, not 400/P0001). `ingestEmail` now maps `!parsed.fromEmail` to 422 `unparseable`, RED-then-GREEN test-driven (`lib/inboxIngest.test.js` cases 5b/5c). A related class (a `.slice(0, max)` clamp splitting a surrogate pair → Postgres 22P05, same infinite-retry shape) was fixed in the same pass with a code-point-aware clamp in `lib/emailParse.js`.

**Hotfix:** Fix-wave commit(s) on `feat/phase3-email-ingestion`, pre-merge (Task 11 of the SDD plan).

**Cross-references:** AGENTS.md landmines 23 (insert-only ingest) and 24 (header-gated Worker verdicts); `.superpowers/sdd/2026-07-31-phase3-email-ingestion/progress.md` Task 11 ledger lines; `.superpowers/sdd/2026-07-31-phase3-email-ingestion/task-11-fixwave-report.md`.

---

## 2026-07-30 — Phase 2 · 2E ship | A "suggestion" that writes to the same state as an explicit control silently overrides the user

**Trigger:** 2E prod live drive, first real premium add. Owner-selected "Blogs & Newsletters", pasted a premium URL, clicked Add — server stored `kind: "news"`. 355 green tests, 12 per-task reviews, and a whole-branch final review had all passed over the code path.

**What went wrong:** `AddSourceModal.jsx` wired `suggestKind(url)` (a domain-based *default*, 2D §4.5) into the premium input's `onBlur` and the discovery success path **unconditionally**. Clicking Add always blurs the input first, so any custom-domain feed (which most paid Substacks are — the drive URL construction-physics.com among them) forced `kind` back to `'news'` after the user had explicitly chosen blog. Every existing test exercised the suggestion in the direction where the user *hadn't* chosen — the pinned blur test itself only asserted the helpful flip.

**Lesson:** when a suggestion/auto-fill writes to the same state as an explicit user control, there must be a test where the user chose *against* the suggestion — and the suggestion must lose.

**Prevention:** `kindTouched` gate (explicit choice latches; suggestions only fill untouched state); RED-first repro test "an explicit kind choice survives premium URL blur"; live-drive gate retained for every slice — this class of composition-with-real-data bug has now been caught by the drive twice (see 2D fallback-leak entry).

**Hotfix:** PR #9 (`041ed02`), same-day; data repaired in place via the row's PATCH edit (label/kind/category are editable post-add — the pencil form).

**Cross-references:** AGENTS.md landmine 21; global rulebook entry same date; auto-memory `masthead-2e-shipped`.

## 2026-07-30 — Phase 2 · 2E ship | window.confirm froze the browser-automation drive; premium delete UX diverges from custom-source delete

**Trigger:** same live drive — clicking "Remove" on the premium Settings row froze all automation (screenshots, clicks, navigation timing out).

**What went wrong:** `PremiumSourceRow.jsx:21` uses native `window.confirm` for delete. Native dialogs block the renderer for CDP-driven automation until a human dismisses them — the drive needed a manual assist. Separately, custom news sources delete instantly with no confirmation at all: two different deletion contracts in the same list.

**Lesson:** native browser dialogs are automation-hostile and off-pattern in an app that owns a designed modal system; deletion UX for sibling row types should share one contract.

**Prevention:** when driving the app via automation, delete premium rows through the authed API (`DELETE /api/premium-feeds`), not the row button. Open follow-up (owner call, not auto-fixed): replace `window.confirm` with an in-app confirm and align custom-source delete.

**Hotfix:** none shipped — behavior works for humans; logged as UX-consistency follow-up.

**Cross-references:** AGENTS.md landmine 22.

## 2026-07-18 — Phase 2 · 2D | rss-parser's default whitelist made the media:* thumbnail path dead code for every feed

**Trigger:** Task 4's house rule that fixtures must be REAL captured payloads — the first live Mastodon capture run through the real parser failed the thumbnail assertion that hand-fed unit-test objects had always passed.

**What went wrong:** `rss-parser`'s default field list drops all `media:content`/`media:thumbnail` elements, so `extractThumbnail()`'s first two branches (`lib/feedParser.js`) had NEVER fired in production — for any feed, since 2B. Existing unit tests passed because they handed the function pre-built objects, bypassing the parser that would have stripped the fields. Invisible until a genuine end-to-end fixture (raw XML → real `Parser` → `mapFeedItems`) was forced through.

**Lesson:** a unit test that feeds a function idealized input can keep dead code green forever; only a real-producer payload through the real pipeline proves a branch is alive.

**Prevention:** `customFields` in the shared `Parser` config; three real captured fixtures (Bluesky, Mastodon, BBC) in `lib/__fixtures__/` exercised through `new Parser(parserOptions)` in `lib/feedParser.test.js` — both media branches now regression-locked. Owner signed off on the blast radius (existing news thumbnails may switch to publisher-designated media URLs).

**Hotfix:** Shipped inside PR #7 (`feat(parser): title fallback… + real bsky/mastodon fixtures` + regression fixture commit).

**Cross-references:** global rulebook (generalizes: parser/SDK default configs silently drop namespaced fields); auto-memory `masthead-2d-blogs-catalog-shipped`.

## 2026-07-18 — Phase 2 · 2D | "Preserve today's behavior" across a taxonomy change = tomorrow's leak

**Trigger:** Final whole-branch review (the only reviewer holding all 12 tasks at once), after every task-scoped review had passed clean.

**What went wrong:** The plan deliberately preserved the pre-2D fallback "zero selected sources → GET the whole catalog" for the News tab. Pre-2D the catalog was all-news, so the fallback was kind-safe by accident. Post-2D the same catalog held blogs + social, so a user who disabled all 15 news toggles (reachable — the ≥1-source guard is global, not per-kind) got all 36 sources leaked into News "All", with social items carrying the wrong link behavior. Task-scoped tests couldn't see it: settingsStore's guard and feedStore's selector were each correct in isolation; the bug only exists in their composition.

**Lesson:** a behavior preserved verbatim across a data-taxonomy change silently inherits the OLD taxonomy's safety assumptions — re-derive every fallback's safety under the new taxonomy, and always run one reviewer over the composed whole.

**Prevention:** `fallbackToCatalog: false` on all kind-scoped surfaces (empty selection → empty state); enforcing no-network tests per surface in `src/stores/feedStore.test.js`; whole-branch final review kept as a standing gate (it caught this).

**Hotfix:** `fix(stores): news surface never falls back to the kind-agnostic catalog` (71b767c, inside PR #7 pre-merge).

**Cross-references:** auto-memory `masthead-2d-blogs-catalog-shipped`; superpowers subagent-driven-development final-review stage.

## 2026-07-18 — Phase 2 · 2C | One bad row silently strands a whole supabase-js batch upsert

**Trigger:** Fresh-context security review of the 2C sync rework, before merge (PR #6).

**What went wrong:** The sign-in sync pushed all local-only saved articles in ONE batched `.upsert([...])`. A single link-less hearted item (`url: ''`, legal locally) violates the table's url CHECK — and because PostgREST runs the batch as one SQL statement, every row in it is rejected. supabase-js does not throw on DB errors; it returns `{ error }`, which the code discarded, and the success log still printed the upload count. Net effect (had it shipped): the user's entire library silently never syncs to the cloud, forever, while the UI claims it's saved.

**Lesson:** supabase-js `try/catch` is a decoy — always inspect the returned `error`; and never let a row that CAN violate a constraint into a batch statement with rows that can't.

**Prevention:** `isCloudSyncable()` pre-filter on every cloud write path + explicit `error` inspection with a loud log; enforcing tests (`src/lib/sync.test.js` "batch-poison" cases). Distilled as AGENTS.md landmine 11.

**Hotfix:** Fixed pre-merge in the same PR (`feat: security-review hardening — batch-poison guard, error inspection, column size caps`).

**Cross-references:** AGENTS.md landmines 11–13; auto-memory `masthead-2c-library-shipped`.

## 2026-07-18 — Phase 2 · 2B/2C rollouts | Prod DDL is owner-run; verify the paste, don't trust it

**Trigger:** Applying the three 2B/2C migrations to prod Supabase during the pre-flight-gated rollouts.

**What went wrong:** Two separate lessons. (1) The Claude Code permission classifier blocks agent-run `supabase db query --linked` DDL even after explicit owner approval in chat — the agent cannot apply migrations, full stop. (2) When the owner first pasted the `!`-prefixed migration command, it arrived as chat text and never executed; the agent nearly proceeded on the assumption it had run. A `to_regclass()` read showed the table was absent.

**Lesson:** prod DDL follows a fixed choreography — agent stages the migration file and enumerates it in ONE pre-flight; owner executes `! supabase db query --linked -f <file>`; agent then proves the result with read-only queries (never from the pasted command's presence).

**Prevention:** Choreography codified as AGENTS.md landmine 14; verification reads (to_regclass, grants/policies, live REST probes) are part of every rollout checklist.

**Hotfix:** N/A — caught before any wrong action; owner re-ran the command via `!` and it applied cleanly.

**Cross-references:** AGENTS.md landmine 14; auto-memory `masthead-2b-storage-shipped` / `masthead-2c-library-shipped`.

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
