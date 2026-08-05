# Phase 3 — Email Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user ingest email address on `masthead.clauding-lab.com` → newsletters parsed, sanitised, quota-gated, stored in Supabase → read in a dedicated Inbox tab.

**Architecture:** Cloudflare Email Routing catch-all → dumb Email Worker forwarder (in-repo `email-worker/`) → `POST /api/inbox-ingest` (all parse/sanitise/quota/store logic in `lib/`, mirrored in `server.js`) → `user_inbox_messages` (service-role insert, RLS owner-read, DB-trigger quota). Client reads via supabase-js under the user's JWT; address lifecycle via authed `api/inbox-address`. Spec: `docs/superpowers/specs/2026-07-30-phase3-email-ingestion-design.md` (read it before any task).

**Tech Stack:** JS/ESM only (no TS). vitest. `postal-mime` (NEW dep, owner-approved in spec §2). `sanitize-html` (server), DOMPurify (client), Zustand, react-router 7, Supabase, Upstash rate limiting, Cloudflare Email Workers (wrangler).

## Global Constraints

- Baseline gates: `npm test` = **358 passing** before this phase — every task leaves ALL tests green; `npm run build` exit 0; `npx eslint src lib api server.js scripts email-worker` adds **zero new** errors/warnings (pre-existing baseline: 4 errors + 5 warnings). Never pipe gate output through head/tail/grep.
- Landmines (AGENTS.md, read in full first): 1 (lib/ dual-consumption — server.js mirrors every route), 5+12 (revoke from PUBLIC; explicit revokes on every new table/function), 11 (`{ error }` checked on EVERY supabase call), 14 (migrations are staged, owner-run), 15 (real fixtures for parser code), 18 (extractor ban), 19 (in-repo dom test harness, no RTL), 20 (store bootstrap in `authStore.initAuth`), 22 (no `window.confirm`).
- New dependency allowed: `postal-mime` ONLY. Nothing else.
- Binding spec rules: ingest path issues INSERT only (never UPDATE/DELETE); no server-side fetch of any sender-controlled URL; bodies/subjects/slugs never logged (log row id + verdict + sizes); every ingest response carries `x-masthead-ingest: 1` header and JSON `{ code }`.
- All byte figures come from `lib/inboxSize.js#messageBytes` — never `.length`, never SQL `length()`.
- Quota constants: 500 live messages, 100 MB (104857600 octets) live bytes, 2 MB (2097152) sanitised message, 10 MB (10485760) raw, 60/hr per-user ingest, grace 7 days.
- Ingest domain string lives in ONE config constant (`INGEST_DOMAIN` in `lib/inboxConfig.js`), never inline.
- Commits: Conventional Commits, imperative, NO attribution lines. Branch `feat/phase3-email-ingestion` (exists; spec committed `feb13fc`). PR per slice: 3A = Tasks 1–11, 3B = Tasks 13–18.
- Public repo: commit/PR text describes what guards enforce, never open-hole narratives.

---

## Slice 3A — ingest pipeline (PR 1)

### Task 1: Migration + custody probe script

**Files:**
- Create: `supabase/migrations/20260731_create_inbox.sql`
- Create: `scripts/probe-inbox-custody.mjs`
- Modify: `package.json` (add `"probe-inbox": "node scripts/probe-inbox-custody.mjs"` to scripts — nothing else)

**Interfaces:**
- Produces: tables `user_ingest_addresses`, `user_inbox_messages`, trigger fn `enforce_inbox_quota` exactly as below — every later task's SQL assumptions come from this file.
- The migration is STAGED ONLY (landmine 14) — the owner runs it later (Task 12). Nothing in 3A's tests hits a real DB.

- [ ] **Step 1: Write the migration exactly as follows** (pattern source: `supabase/migrations/20260719_create_user_premium_feeds.sql`)

```sql
-- Phase 3: newsletter inbox (spec §4). Addresses: service-role-only custody.
-- Messages: service-role insert; owner may read + update read_at/deleted_at.
create table public.user_ingest_addresses (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references auth.users (id) on delete cascade,
  slug              text unique check (slug is null or slug ~ '^[a-z]{3,12}-[a-z]{3,12}-[0-9a-f]{4}$'),
  over_quota_since  timestamptz,
  deferred_count    bigint not null default 0,
  last_deferred_at  timestamptz,
  created_at        timestamptz not null default now()
);

create table public.user_inbox_messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  from_email       text not null check (length(from_email) <= 320),
  from_name        text check (from_name is null or length(from_name) <= 200),
  subject          text not null default '' check (length(subject) <= 500),
  html_body        text,
  text_body        text,
  excerpt          text check (excerpt is null or length(excerpt) <= 500),
  size_bytes       integer not null check (size_bytes >= 0),
  web_url          text check (web_url is null or (web_url ~* '^https://' and length(web_url) <= 4000)),
  unsubscribe_url  text check (unsubscribe_url is null or length(unsubscribe_url) <= 4000),
  auth_results     text check (auth_results is null or length(auth_results) <= 2000),
  dedupe_key       text not null check (length(dedupe_key) <= 998),
  message_id       text check (message_id is null or length(message_id) <= 998),
  received_at      timestamptz not null default now(),
  read_at          timestamptz,
  deleted_at       timestamptz,
  constraint user_inbox_messages_dedupe unique (user_id, dedupe_key)
);

create index user_inbox_messages_list_idx
  on public.user_inbox_messages (user_id, received_at desc) where deleted_at is null;
create index user_inbox_messages_unread_idx
  on public.user_inbox_messages (user_id) where read_at is null and deleted_at is null;

-- Quota enforcement lives in Postgres (2E cap-trigger pattern; spec §4.2):
-- app-level check-then-insert is a TOCTOU race. Per-user advisory xact lock.
create or replace function public.enforce_inbox_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live_count int;
  live_bytes bigint;
begin
  perform pg_advisory_xact_lock(hashtext('inbox_quota'), hashtext(new.user_id::text));
  select count(*), coalesce(sum(size_bytes), 0)
    into live_count, live_bytes
    from public.user_inbox_messages
   where user_id = new.user_id and deleted_at is null;
  if live_count >= 500 or live_bytes + new.size_bytes > 104857600 then
    raise exception 'inbox quota exceeded' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger user_inbox_messages_quota
  before insert on public.user_inbox_messages
  for each row execute function public.enforce_inbox_quota();

-- Un-delete is forbidden (spec §4.2): the deleted_at column grant would
-- otherwise let a client resurrect tombstoned rows past the quota with no
-- trigger on the UPDATE path. The product has no restore feature.
create or replace function public.forbid_inbox_undelete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'undelete is not permitted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger user_inbox_messages_no_undelete
  before update of deleted_at on public.user_inbox_messages
  for each row execute function public.forbid_inbox_undelete();

-- Custody (landmines 5 + 12: this project auto-grants via pg_default_acl —
-- explicit revokes are mandatory, and PUBLIC must be named).
alter table public.user_ingest_addresses enable row level security;
revoke all on table public.user_ingest_addresses from anon, authenticated, public;

alter table public.user_inbox_messages enable row level security;
revoke all on table public.user_inbox_messages from anon, authenticated, public;
grant select on table public.user_inbox_messages to authenticated;
grant update (read_at, deleted_at) on table public.user_inbox_messages to authenticated;
create policy inbox_messages_select_own on public.user_inbox_messages
  for select to authenticated using (auth.uid() = user_id);
create policy inbox_messages_update_own on public.user_inbox_messages
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on function public.enforce_inbox_quota() from anon, authenticated, public;
revoke all on function public.forbid_inbox_undelete() from anon, authenticated, public;
```

- [ ] **Step 2: Write `scripts/probe-inbox-custody.mjs`** — copy the structure of `scripts/probe-premium-custody.mjs` (env loader, `expectDenied`, exit code) and probe:
  - anon SELECT/INSERT/UPDATE/DELETE on `user_ingest_addresses` → all denied
  - anon SELECT/INSERT/DELETE on `user_inbox_messages` → denied; anon UPDATE → denied
  - anon RPC `enforce_inbox_quota` → denied (POST `rest/v1/rpc/enforce_inbox_quota`, expect 401/404)
  - Optional block behind `SUPABASE_SERVICE_ROLE_KEY` + `PROBE_USER_ID` (2E pattern): (a) concurrency — insert a 60 KB-size row 8× in parallel after seeding 498 rows is impractical; instead insert 8 parallel rows each with `size_bytes: 20000000` (20 MB declared) → exactly 5 land (5×20 MB = 100 MB cap); (b) byte equality — insert one row with a multi-byte body via service role, then read back the SERVER-side measure (`octet_length(html_body) + octet_length(text_body)` via a select on those expressions, or PostgREST's computed select) and assert it equals the `Buffer.byteLength` number computed client-side BEFORE the insert — the two sides must be independent producers or the check is `x === x` and vacuous; (c) EVERY cleanup delete is scoped to probe rows only (`dedupe_key=like.<probe-prefix>*`) — never a bare `user_id=eq.` delete, which would destroy the probe user's real inbox when an owner re-runs the probe post-launch.
  - Authenticated-role probes require a user JWT the probe cannot mint (2E precedent: skipped with documented compensating evidence — the RLS policies + column grants are read back by the agent post-migration instead).

- [ ] **Step 3: Run `npm test` (must stay 358 green — nothing imports these yet), `npx eslint scripts` (zero new)**

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260731_create_inbox.sql scripts/probe-inbox-custody.mjs package.json
git commit -m "feat(3a): inbox migration (staged) + custody probe script"
```

### Task 2: `lib/inboxSize.js` + `lib/inboxConfig.js`

**Files:**
- Create: `lib/inboxSize.js`, `lib/inboxSize.test.js`, `lib/inboxConfig.js`

**Interfaces:**
- Produces: `messageBytes(html, text) -> number` (UTF-8 octets, null-safe) — the ONLY byte producer in Phase 3. `inboxConfig.js` exports `INGEST_DOMAIN = 'masthead.clauding-lab.com'`, `MAX_RAW_BYTES = 10485760`, `MAX_MESSAGE_BYTES = 2097152`, `MAX_LIVE_MESSAGES = 500`, `MAX_LIVE_BYTES = 104857600`, `GRACE_MS = 7 * 24 * 60 * 60 * 1000`.

- [ ] **Step 1: Failing test** (`lib/inboxSize.test.js`)

```js
import { describe, it, expect } from 'vitest';
import { messageBytes } from './inboxSize.js';

describe('messageBytes', () => {
  it('counts UTF-8 octets, not JS chars', () => {
    expect(messageBytes('abc', '')).toBe(3);
    expect(messageBytes('é', '')).toBe(2);        // U+00E9
    expect(messageBytes('中', '')).toBe(3);        // CJK
    expect(messageBytes('—', '')).toBe(3);        // em-dash
    expect(messageBytes(' ', '')).toBe(2);   // NBSP
    expect(messageBytes('😀', '')).toBe(4);       // astral plane (JS length 2)
  });
  it('sums both parts and treats null/undefined as empty', () => {
    expect(messageBytes('ab', 'cd')).toBe(4);
    expect(messageBytes(null, undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Run `npx vitest run lib/inboxSize.test.js` — expect FAIL (module not found)**

- [ ] **Step 3: Implement**

```js
// lib/inboxSize.js — the ONLY producer of a byte figure in the inbox slice.
// Postgres length() counts characters; JS .length counts UTF-16 units.
// Anything named *bytes* must come from here (spec §5.1).
export function messageBytes(html, text) {
  return Buffer.byteLength(html ?? '', 'utf8') + Buffer.byteLength(text ?? '', 'utf8');
}
```

```js
// lib/inboxConfig.js — single home for the ingest domain + quota constants (spec §6).
export const INGEST_DOMAIN = 'masthead.clauding-lab.com';
export const MAX_RAW_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_LIVE_MESSAGES = 500;
export const MAX_LIVE_BYTES = 100 * 1024 * 1024;
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Run the test — PASS. Commit: `feat(3a): inbox byte helper + config constants`**

### Task 3: `lib/ingestAuth.js`

**Files:**
- Create: `lib/ingestAuth.js`, `lib/ingestAuth.test.js`

**Interfaces:**
- Produces: `verifyIngestSecret(req) -> boolean`. Reads header `x-ingest-secret`; compares constant-time against `INGEST_SECRET` and (if set) `INGEST_SECRET_PREV`. Unset primary secret → always false (fail-closed).

- [ ] **Step 1: Failing tests** — model on `lib/cronAuth.js`/its test:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { verifyIngestSecret } from './ingestAuth.js';

describe('verifyIngestSecret', () => {
  beforeEach(() => {
    delete process.env.INGEST_SECRET;
    delete process.env.INGEST_SECRET_PREV;
  });
  const req = (v) => ({ headers: v === undefined ? {} : { 'x-ingest-secret': v } });

  it('rejects when INGEST_SECRET is unset (fail-closed), even on empty match', () => {
    expect(verifyIngestSecret(req(''))).toBe(false);
    expect(verifyIngestSecret(req(undefined))).toBe(false);
  });
  it('accepts the current secret, rejects wrong/absent/prefix values', () => {
    process.env.INGEST_SECRET = 's3cret-value';
    expect(verifyIngestSecret(req('s3cret-value'))).toBe(true);
    expect(verifyIngestSecret(req('s3cret-valu'))).toBe(false);
    expect(verifyIngestSecret(req('s3cret-value2'))).toBe(false);
    expect(verifyIngestSecret(req(undefined))).toBe(false);
  });
  it('accepts INGEST_SECRET_PREV during rotation, only when primary is set', () => {
    process.env.INGEST_SECRET = 'new';
    process.env.INGEST_SECRET_PREV = 'old';
    expect(verifyIngestSecret(req('old'))).toBe(true);
    expect(verifyIngestSecret(req('new'))).toBe(true);
    delete process.env.INGEST_SECRET;
    expect(verifyIngestSecret(req('old'))).toBe(false);
  });
  it('never throws on non-string header', () => {
    process.env.INGEST_SECRET = 'x';
    expect(verifyIngestSecret({ headers: { 'x-ingest-secret': 42 } })).toBe(false);
    expect(verifyIngestSecret({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** (length-guarded `timingSafeEqual` per `lib/cronAuth.js`; helper `matches(header, secret)` applied to both secrets). **Step 4: PASS. Commit: `feat(3a): fail-closed ingest secret auth with rotation support`**

### Task 4: `lib/sanitizeEmail.js`

**Files:**
- Create: `lib/sanitizeEmail.js`, `lib/sanitizeEmail.test.js`

**Interfaces:**
- Produces: `sanitizeEmailHtml(html) -> string`. sanitize-html config: article config (`lib/sanitizeServer.js`) PLUS tables (`table,thead,tbody,tfoot,tr,td,th`, `center`), `style` attribute on all allowed tags under a CSS property allowlist, minus `mailto` scheme on img. Strips: `cid:` refs, images with declared width≤2 or height≤2, NUL chars. Forces every `<a>` to `target="_blank" rel="noopener noreferrer"`.

- [ ] **Step 1: Failing tests** — the load-bearing table:

```js
import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from './sanitizeEmail.js';

describe('sanitizeEmailHtml', () => {
  it.each([
    ['<script>alert(1)</script><p>hi</p>', 'script'],
    ['<p onclick="x()">hi</p>', 'onclick'],
    ['<iframe src="https://x.test"></iframe>', 'iframe'],
    ['<form action="https://x.test"><input name="a"></form>', 'form'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<img src="cid:part1">', 'cid:'],
    ['<svg onload="x()"></svg>', 'svg'],
  ])('strips XSS vector %#', (input, marker) => {
    expect(sanitizeEmailHtml(input)).not.toContain(marker);
  });

  it('keeps tables and allowlisted inline styles', () => {
    const out = sanitizeEmailHtml(
      '<table><tr><td style="color:#333;font-size:14px;padding:8px">x</td></tr></table>');
    expect(out).toContain('<table>');
    expect(out).toContain('color');
    expect(out).toContain('font-size');
  });
  it('strips overlay-capable style properties, keeps benign ones', () => {
    const out = sanitizeEmailHtml('<div style="position:fixed;z-index:9999;color:red">x</div>');
    expect(out).not.toContain('position');
    expect(out).not.toContain('z-index');
    expect(out).toContain('color');
  });
  it('strips tracker pixels (declared dims <= 2) but keeps real images', () => {
    const out = sanitizeEmailHtml(
      '<img src="https://t.test/p.gif" width="1" height="1"><img src="https://t.test/photo.jpg" width="600" height="400">');
    expect(out).not.toContain('p.gif');
    expect(out).toContain('photo.jpg');
  });
  it('forces link target+rel', () => {
    const out = sanitizeEmailHtml('<a href="https://x.test/a">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('noopener');
  });
  it('strips NUL characters (Postgres rejects them)', () => {
    expect(sanitizeEmailHtml('a\0b')).not.toContain('\0');
  });
  it('returns empty string for null/empty input', () => {
    expect(sanitizeEmailHtml(null)).toBe('');
  });
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement:**

```js
import sanitizeHtml from 'sanitize-html';

// Email-tuned server sanitiser (spec §8.3). Newsletters need tables + inline
// styles; the style allowlist excludes every overlay/positioning vector.
const ALLOWED_STYLES = {
  '*': {
    color: [/^.*$/], 'background-color': [/^.*$/], background: [/^(?!.*url).*$/i],
    'font-family': [/^.*$/], 'font-size': [/^.*$/], 'font-weight': [/^.*$/],
    'font-style': [/^.*$/], 'line-height': [/^.*$/], 'letter-spacing': [/^.*$/],
    'text-align': [/^.*$/], 'text-decoration': [/^.*$/], 'text-transform': [/^.*$/],
    padding: [/^.*$/], 'padding-top': [/^.*$/], 'padding-right': [/^.*$/],
    'padding-bottom': [/^.*$/], 'padding-left': [/^.*$/],
    margin: [/^.*$/], 'margin-top': [/^.*$/], 'margin-right': [/^.*$/],
    'margin-bottom': [/^.*$/], 'margin-left': [/^.*$/],
    border: [/^.*$/], 'border-radius': [/^.*$/], 'border-collapse': [/^.*$/],
    width: [/^.*$/], 'max-width': [/^.*$/], height: [/^.*$/], display: [/^(?!none).*$/i],
    'vertical-align': [/^.*$/], 'white-space': [/^.*$/],
  },
};

const OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'figure', 'figcaption', 'picture', 'source', 'center',
  ],
  allowedAttributes: {
    '*': ['style'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
    source: ['srcset', 'type', 'media'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
  },
  allowedStyles: ALLOWED_STYLES,
  allowedSchemes: ['http', 'https'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
  exclusiveFilter(frame) {
    if (frame.tag !== 'img') return false;
    const w = parseInt(frame.attribs?.width, 10);
    const h = parseInt(frame.attribs?.height, 10);
    return (Number.isFinite(w) && w <= 2) || (Number.isFinite(h) && h <= 2); // tracker pixels
  },
};

export function sanitizeEmailHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html).replace(/\0/g, ''), OPTIONS);
}
```

(`allowedTags` default set already excludes script/iframe/form/svg. Verify each test passes; adjust ONLY within this config shape.)

- [ ] **Step 4: PASS. Also run `npx vitest run lib/sanitizeServer.test.js` — the article sanitiser is untouched and must stay green. Commit: `feat(3a): email-tuned server sanitiser with CSS property allowlist`**

### Task 5: `postal-mime` + `lib/emailParse.js` + real fixtures

**Files:**
- Modify: `package.json` (+`postal-mime`, exact latest version via `npm install postal-mime`)
- Create: `lib/emailParse.js`, `lib/emailParse.test.js`, `lib/__fixtures__/email/*.eml`

**Interfaces:**
- Produces: `parseEmail(rawBuffer) -> Promise<parsed|null>` where parsed = `{ fromEmail, fromName, subject, html, text, messageId, dateHeader, webUrl, unsubscribeUrl, authResults, dedupeKey }`. Returns `null` ONLY for deterministically unparseable input (maps to verdict 422). `dedupeKey` = `messageId` when present, else `sha256(fromEmail + '\n' + subject + '\n' + dateHeader + '\n' + sha256(html + text))` hex via `node:crypto`.

- [ ] **Step 1: `npm install postal-mime` (the ONE allowed new dep)**

- [ ] **Step 2: Create fixtures.** Real-payload rule (landmine 15): build `substack.eml`, `beehiiv.eml`, `mailchimp.eml` by fetching a REAL public newsletter web version (e.g. one construction-physics.com Substack post's public HTML) and wrapping the real HTML in a real multipart MIME envelope with genuine headers (Message-ID, List-Unsubscribe, List-Post, Date, quoted-printable encoding for at least one). Also `pathological.eml`: 6-level-deep multipart nesting, a malformed header line, an 8-bit charset part (ISO-8859-1 with é bytes), a NUL byte in the body, no Message-ID. Note in each fixture's first comment line where its HTML came from. **Fixture upgrade duty:** the owner exports 2–3 genuine `.eml` files from their real mail during the Task 12 batch; swap them in before the 3B merge and re-run this task's tests.

- [ ] **Step 3: Failing tests:**

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseEmail } from './emailParse.js';

const load = (n) => readFileSync(new URL(`./__fixtures__/email/${n}`, import.meta.url));

describe('parseEmail', () => {
  it('parses the substack fixture: from, subject, html, messageId, unsubscribe, webUrl', async () => {
    const p = await parseEmail(load('substack.eml'));
    expect(p.fromEmail).toMatch(/@/);
    expect(p.subject.length).toBeGreaterThan(0);
    expect(p.html).toContain('<');
    expect(p.messageId).toBeTruthy();
    expect(p.dedupeKey).toBe(p.messageId);
    expect(p.unsubscribeUrl === null || /^(https:|mailto:)/.test(p.unsubscribeUrl)).toBe(true);
    expect(p.webUrl === null || p.webUrl.startsWith('https://')).toBe(true);
  });
  it('survives the pathological fixture and falls back to a content-hash dedupe key', async () => {
    const p = await parseEmail(load('pathological.eml'));
    expect(p).not.toBeNull();
    expect(p.messageId).toBeNull();
    expect(p.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
  });
  it('same content yields the same fallback key; different content different key', async () => {
    const a = await parseEmail(load('pathological.eml'));
    const b = await parseEmail(load('pathological.eml'));
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
  it('returns null for garbage that is not MIME at all', async () => {
    expect(await parseEmail(Buffer.from([0xff, 0xfe, 0x00]))).toBeNull();
  });
  it('extracts List-Unsubscribe https over mailto when both present', async () => {
    const p = await parseEmail(load('mailchimp.eml'));
    expect(p.unsubscribeUrl).not.toBeNull();
    expect(p.unsubscribeUrl.startsWith('https://')).toBe(true);
  });
});
```

- [ ] **Step 4: Run — FAIL. Step 5: Implement** — `PostalMime.parse(raw)`; take html/text/subject/from/messageId/date/headers; `webUrl`: `List-Post` header `<https://…>` value else first anchor whose text matches `/view.*(online|browser)/i`, https-only, ≤4000 chars, else null; `unsubscribeUrl`: parse `List-Unsubscribe` header's comma-separated `<…>` entries, prefer first `https:`, else first `mailto:`, else null; `authResults` from `Authentication-Results` header (first 2000 chars) else null; clamp fromEmail 320 / fromName 200 / subject 500 with control chars stripped (`/[\u0000-\u001f\u007f]/g`); wrap `PostalMime.parse` in try/catch → null. **Step 6: PASS. Commit: `feat(3a): MIME parsing with dedupe-key fallback and real fixtures`**

### Task 6: `lib/inboxRepo.js` (service-role data access) + security boundary

**Files:**
- Create: `lib/inboxRepo.js`, `lib/inboxRepo.test.js`, `lib/ingestSlug.js`, `lib/ingestSlug.test.js`
- Modify: `lib/securityBoundary.test.js` (add `lib/inboxRepo.js` to the supabaseAdmin importer allowlist — the `permitted` set in the last test)

**Interfaces:**
- `ingestSlug.js`: `generateSlug(randomFn?) -> 'word-word-hex4'` from an embedded ~200-word curated list (lowercase 3–12 letters, no offensive/brand words) + 4 hex chars from `crypto.randomBytes`.
- `inboxRepo.js` (all via `getAdminClient()`, every call checks `{ error }` — landmine 11; DB errors throw `InboxRepoError`):
  - `findAddressBySlug(slug) -> { id, userId, overQuotaSince } | null`
  - `getAddressRow(userId) -> { address row } | null`
  - `ensureAddress(userId) -> row` (semantics of INSERT … ON CONFLICT (user_id) DO UPDATE SET slug = excluded.slug WHERE user_ingest_addresses.slug IS NULL, preserved race-free: select → if row with slug return it → if row with null slug, `.update({ slug }).eq('user_id', userId).is('slug', null).select(…).maybeSingle()` — a null result means a concurrent caller won, so re-select and return the winner's row → if no row, plain `.insert()`; on user_id unique-violation (23505) a concurrent insert won, re-select; on slug unique-violation retry `generateSlug` up to 3×. Never an unguarded upsert — two concurrent calls must both end up returning the single slug the DB actually holds)
  - `rotateSlug(userId) -> row` (UPDATE slug = new; retry on unique violation ×3)
  - `disableSlug(userId) -> void` (UPDATE slug = null)
  - `quotaSnapshot(userId) -> { messageCount, bytesUsed }` (one select: `count`, `sum(size_bytes)` over live rows — use `.select('size_bytes')` + reduce, or a `count(head)` + a sum select; two queries acceptable)
  - `insertMessage(row) -> 'inserted' | 'duplicate' | 'over_quota'` (single INSERT; map unique-violation on dedupe constraint → 'duplicate'; trigger exception message containing 'inbox quota exceeded' → 'over_quota')
  - `markDeferred(userId)` / `clearDeferred(userId)` (over_quota_since set-if-null + counters / reset to null)
- Consumes: `getAdminClient` from `lib/supabaseAdmin.js`, `generateSlug`.

- [ ] **Step 1: `ingestSlug` failing tests:** format regex `^[a-z]{3,12}-[a-z]{3,12}-[0-9a-f]{4}$` over 200 generated slugs; injectable `randomFn` yields deterministic slug; word list length ≥ 150 and all entries `/^[a-z]{3,12}$/`. **Step 2: FAIL → implement → PASS.**

- [ ] **Step 3: `inboxRepo` failing tests** with a mocked admin client (pattern: `lib/premiumRepo.test.js` — mock `getAdminClient` via `vi.mock('./supabaseAdmin.js', …)`): every function checks `{ error }` and throws `InboxRepoError` on it; `insertMessage` maps `{ code: '23505' }` → 'duplicate', `{ message: '… inbox quota exceeded …' }` → 'over_quota', clean → 'inserted'; `ensureAddress` retries a slug collision then succeeds; `rotateSlug` updates in place (asserts `.update` called, never `.delete`/`.insert`); `disableSlug` sets `slug: null`. **Step 4: FAIL → implement → PASS.**

- [ ] **Step 5: Update `lib/securityBoundary.test.js` allowlist, run it, PASS. Full `npm test` green. Commit: `feat(3a): inbox repo (service-role) + slug generation`**

### Task 7: `lib/inboxIngest.js` + `api/inbox-ingest.mjs` + server.js mirror

**Files:**
- Create: `lib/inboxIngest.js`, `lib/inboxIngest.test.js`, `api/inbox-ingest.mjs`, `api/inbox-ingest.test.js`
- Modify: `server.js` (register the route), `vercel.json` (functions entry `"api/inbox-ingest.mjs": { "maxDuration": 30 }`)

**Interfaces:**
- `inboxIngest.js`: `ingestEmail({ envelopeTo, rawBuffer }, deps) -> { status, code }` — deps `{ repo, parse, sanitize, limiter, now }` default to the real modules; every verdict from spec §3's table. Codes: `accepted`, `duplicate`, `unknown_recipient`, `message_too_large`, `unparseable`, `over_quota` (transient, status 429), `over_quota_final` (status 507), `rate_limited`, `disabled`.
- `api/inbox-ingest.mjs`: POST-only Vercel handler, NO applyCors. Streams the raw body manually (Vercel parses JSON bodies only when content-type says so; the Worker sends `application/octet-stream` — VERIFY with a test that the handler reads a Buffer; if `req.body` arrives pre-buffered use it, else accumulate `req.on('data')` with the 10 MB cap aborting at 413). Sets `x-masthead-ingest: 1` on EVERY response incl. 401/500.
- Produces for Task 10: the exact JSON `{ code }` + header contract.

- [ ] **Step 1: Failing tests for `ingestEmail`** — mocked deps; the verdict table, one test per row:

```js
// abbreviated shape — implement ALL of these cases:
// secret handled at route layer; ingestEmail starts at envelope parsing.
// 1. unknown slug -> { status: 404, code: 'unknown_recipient' }; parse never called
// 2. disabled (INGEST_DISABLED=1) -> { status: 429, code: 'disabled' }; repo untouched
// 3. rate limited (limiter returns allowed:false) -> 429 rate_limited; parse never called
// 4. raw > MAX_RAW_BYTES -> 413 message_too_large; parse never called
// 5. parse returns null -> 422 unparseable
// 6. sanitised size > MAX_MESSAGE_BYTES -> 413 message_too_large
// 7. repo.insertMessage 'duplicate' -> 200 duplicate; markDeferred NOT called
// 8. repo.insertMessage 'inserted' -> 201 accepted; clearDeferred called
// 9. repo 'over_quota', overQuotaSince null -> 429 over_quota; markDeferred called
// 10. repo 'over_quota', overQuotaSince 3 days ago -> 429 over_quota (within grace)
// 11. repo 'over_quota', overQuotaSince 8 days ago -> 507 over_quota_final
// 12. local-part normalisation: 'Quiet-Harbor-4f2a+tag@...' finds slug 'quiet-harbor-4f2a'
// 13. envelopeTo on the wrong domain -> 404 unknown_recipient
// 14. INSERT-only pin: run cases 1-11; assert the repo mock NEVER received update/delete
//     calls other than markDeferred/clearDeferred (which touch user_ingest_addresses only)
// 15. dedupe precedes quota: 'duplicate' verdict even when quotaSnapshot says full
//     (insertMessage handles both; assert order: insertMessage called, no pre-quota rejection)
// 16. NUL-strip pin (ledgered T5 carry-forward; write this test FIRST and watch it fail):
//     parsed message whose text body and subject contain U+0000 (construct the bytes with
//     String.fromCharCode(0) / Buffer — never a raw control byte typed into source) ->
//     the row handed to repo.insertMessage contains no U+0000 in ANY string field
//     (text_body, excerpt, subject, from_name, from_email); Postgres text cannot store 0x00
//     and sanitizeEmailHtml covers html only
// 17. unknown-recipient metering (spec §5 red-team: per-slug keys meter nothing an attacker
//     cares about — without this, slug-enumeration probes 404 before touching any limiter):
//     every 404-producing path (unknown slug AND wrong-domain envelope) consumes global
//     bucket 'inbox:unknown' (120/hr); when that bucket
//     denies -> { status: 429, code: 'rate_limited' } instead of 404 (no enumeration
//     feedback, transient so the Worker defers); known-slug traffic never touches this bucket
```

Each case is a real `it()` with explicit mock returns and `expect` assertions — write them all.

- [ ] **Step 2: FAIL → Step 3: implement `ingestEmail`:** envelope parse (`/^(.+)@(.+)$/` on lowercased `envelopeTo`, strip `+suffix` from local part, domain must equal `INGEST_DOMAIN`) → `INGEST_DISABLED` check → `repo.findAddressBySlug` (null → consume global `inbox:unknown` 120/hr; denied → 429 rate_limited, else 404 unknown_recipient — case 17) → per-user limiter `inbox:<userId>` 60/hr + global `inbox:global` 1000/hr → raw size gate → `parse(rawBuffer)` → sanitize html → `messageBytes` gate → build row (excerpt: text else stripped html, collapsed whitespace, 200 chars; strip U+0000 from every string field of the row — case 16) → `repo.insertMessage` → verdict incl. grace ladder via `markDeferred`/`clearDeferred` + `now() - overQuotaSince > GRACE_MS`. Log ONE line per message: `[ingest] <verdict.code> row=<addressRowId ?? 'none'> bytes=<n>` — never slug/subject/body. **Step 4: PASS.**

- [ ] **Step 5: Failing tests for the route** (`api/inbox-ingest.test.js`, pattern: `api/premium-feeds.test.js` req/res mocks): 405 on GET; 401 + `x-masthead-ingest: 1` header on bad secret; happy path pipes buffer to `ingestEmail` and relays `{ status, code }` + header; 500 path also carries the header. **Step 6: implement route + `server.js` mirror** (Hono: `app.post('/api/inbox-ingest', …)` reading `await c.req.arrayBuffer()`, adapting to the same lib call — landmine 1) + `vercel.json` entry. **Step 7: PASS, full `npm test`, build, eslint. Commit: `feat(3a): ingest pipeline + route with authenticated verdict contract`**

### Task 8: `api/inbox-address.mjs`

**Files:**
- Create: `api/inbox-address.mjs`, `api/inbox-address.test.js`
- Modify: `server.js` (mirror), `vercel.json` (functions entry, maxDuration 15)

**Interfaces:**
- Produces (client contract for 3B): `GET` → 200 `{ address: 'slug@masthead.clauding-lab.com' | null, bytesUsed, messageCount, overQuotaSince, deferredCount }`; `POST {}` → 200 same shape (create-if-absent); `POST { regenerate: true }` → 200 new address; `DELETE` → 200 `{ address: null, … }`. All via `requireUser` (401 fail-closed), rate limit `inbox-addr:<ip>` 10/60s + `inbox-addr-user:<userId>` 10/60s. CORS via `applyCors` like sibling routes.

- [ ] **Step 1: Failing tests** (mock `requireUser`, repo): 401 when requireUser throws AuthError; GET with no row → `{ address: null, bytesUsed: 0, messageCount: 0 }`; GET composes `slug@INGEST_DOMAIN`; POST idempotent (row with slug → same address back, `ensureAddress` not `rotateSlug`); POST regenerate calls `rotateSlug`; DELETE calls `disableSlug` and returns address null with quota figures intact; 405 PATCH; 429 when limiter denies. **Step 2: FAIL → implement (dispatch shape: copy `api/premium-feeds.mjs`) → PASS. Mirror in server.js. Commit: `feat(3a): address lifecycle route (row-preserving verbs)`**

### Task 9: `api/cron/inbox-purge.mjs`

**Files:**
- Create: `api/cron/inbox-purge.mjs`, `api/cron/inbox-purge.test.js`, `lib/inboxPurge.js`, `lib/inboxPurge.test.js`
- Modify: `vercel.json` (crons: add `{ "path": "/api/cron/inbox-purge", "schedule": "17 2 * * *" }`; functions entry maxDuration 60)

**Interfaces:**
- `lib/inboxPurge.js`: `runInboxPurge(deps?) -> { ok, hardDeleted, pressureDeleted }`. Pass (a): hard-delete rows with `least(deleted_at, now()) < now() - interval '30 days'` semantics, expressed as TWO DIRECT FILTERED DELETES (no id prefetch — direct deletes avoid PostgREST max-rows truncation, 414-length `.in()` URLs, and the SELECT→DELETE race): `.delete({count:'exact'}).lt('deleted_at', cutoff).not('deleted_at','is',null)` and `.delete({count:'exact'}).gt('deleted_at', nowIso).lt('received_at', cutoff).not('deleted_at','is',null)`. Pass (b) byte pressure: build the per-user byte snapshot with DETERMINISTIC PAGINATION (`.order('id').range(from, from+PAGE-1)` looping until a short page — the project's API max-rows cap must not be able to silently truncate totals); for users whose TOTAL `sum(size_bytes)` (live + tombstoned) > 2 × MAX_LIVE_BYTES, delete oldest tombstoned rows until under, `.in('id', batch)` batched ≤100 ids (UUID query-string length ceiling) with `.not('deleted_at','is',null)` on every batch. `{ error }` per call and per batch (landmine 11).
- Route: copy `api/cron/poll.mjs` shape with `verifyCronAuth`.

- [ ] **Step 1: Failing tests:** route 401 without cron secret / 405 wrong method / 503 when runInboxPurge throws; lib: mocked admin client — pass (a) deletes only eligible tombstones (fresh tombstone survives, 31-day one goes, live row untouched); future-dated `deleted_at` doesn't dodge purge forever; pass (b) triggers only above 2× cap and deletes tombstones only; batches of ≤500. **Step 2: FAIL → implement → PASS. Mirror route in server.js. Commit: `feat(3a): inbox purge cron (tombstone + byte-pressure passes)`**

### Task 10: `email-worker/` (Cloudflare Email Worker)

**Files:**
- Create: `email-worker/handler.js`, `email-worker/handler.test.js`, `email-worker/worker.js`, `email-worker/wrangler.toml`, `email-worker/README.md`
- Modify: `eslint.config.js` (email-worker/ files get Node-ish globals: `fetch`, `Response`, `console`; verify the lint command covers the dir), `package.json` lint script if needed

**Interfaces:**
- `handler.js` (pure, vitest-covered): `verdictFromResponse(status, headers, bodyJson) -> { action: 'accept' | 'reject' | 'defer', reason? }` and `REJECT_CODES = { unknown_recipient: 'No such recipient', message_too_large: 'Message too large', unparseable: 'Message could not be processed', over_quota_final: 'Recipient mailbox is full' }`.
- `worker.js` (thin shell, NOT unit-tested): Email Worker `email(message, env, ctx)` — `message.rawSize > MAX_RAW_BYTES` → `setReject('Message too large')`; read `message.raw` stream to ArrayBuffer; `fetch(env.INGEST_URL, { method: 'POST', headers: { 'x-ingest-secret': env.INGEST_SECRET, 'x-envelope-to': message.to, 'x-envelope-from': message.from, 'content-type': 'application/octet-stream' }, body })`; parse JSON body (failure → `{}`); apply verdict — accept → return; reject → `setReject(reason)`; defer → `throw new Error('deferred: ' + (bodyJson.code || status))` (throw = transient per spec §3; VERIFIED against Cloudflare docs/behaviour during Task 12 before catch-all activation).
- `wrangler.toml`: `name = "masthead-email-ingest"`, `main = "worker.js"`, compatibility_date current; vars: `INGEST_URL`; secret: `INGEST_SECRET` (set via `wrangler secret put`, NEVER in the file).

- [ ] **Step 1: Failing `handler.test.js`:** every §3 verdict row; **foreign-response protection:** status 404 with NO `x-masthead-ingest` header → defer (never reject); HTML body/undefined json → defer; 200 without header → accept is still safe? NO — spec: only OUR 2xx accepts; a bare 200 → accept (delivery succeeded is the safe reading? It did NOT ingest) — decision pinned in spec §3: verdicts require the header for ALL actions; bare 2xx → defer. Test exactly that. **Step 2: FAIL → implement → PASS. Step 3: eslint covers the dir with zero new. Commit: `feat(3a): email worker forwarder with authenticated-verdict mapping`**

### Task 11: 3A gates + PR

- [ ] `npm test` exit 0 — report exact count (baseline 358 + new); `npm run build` exit 0; `npx eslint src lib api server.js scripts email-worker` — 4 errors + 5 warnings, zero new. No output filtering.
- [ ] Dev-loop smoke (documented in `email-worker/README.md`): `npm run dev:api` + `curl -X POST localhost:<port>/api/inbox-ingest -H 'x-ingest-secret: dev' --data-binary @lib/__fixtures__/email/substack.eml` with `INGEST_SECRET=dev` and a stubbed/absent DB → expect the 404 unknown_recipient JSON (proves routing + auth + parse path without a DB).
- [ ] Push branch, `gh pr create` (title `feat(3a): newsletter inbox ingest pipeline`; body: what the guards enforce, gates evidence, staged-migration note; no open-hole narrative), watch checks, **merge on green** (autonomous batch), verify Vercel prod deployment SHA + `/api/inbox-ingest` returns 401 with the verdict header (fail-closed pre-migration).

### Task 12: Owner-gated infra batch (owner + orchestrator, in-session — NOT a subagent task)

Handover checklist the orchestrator prepares verbatim (spec §10.2 order is binding):
1. Cloudflare dashboard pre-check (owner, ~2 min): zone `clauding-lab.com` → Email Routing → can a subdomain (`masthead`) be enabled WITHOUT changing apex MX? If no → STOP, execute spec §2 fallback (buy `masthead.email`, same steps on its apex).
2. Owner regenerates CF API token → `~/.cloudflare/token` (scopes: Zone.DNS edit, Email Routing rules edit, Workers Scripts edit for the account).
3. Owner runs migration in-session: `! supabase db query --linked -f supabase/migrations/20260731_create_inbox.sql` — agent then VERIFIES BY READS: `to_regclass` ×2, trigger present, grants/policies via `information_schema` + `has_function_privilege`, `npm run probe-inbox` all-PASS.
4. Secret: agent generates (`openssl rand -hex 32`), owner (or agent w/ approval) sets Vercel env `INGEST_SECRET` (prod) + redeploy; verify the deployed fn accepts the new secret via a 404-unknown-recipient probe (not 401).
5. Agent: `wrangler deploy` in `email-worker/` + `wrangler secret put INGEST_SECRET`; set `INGEST_URL=https://masthead-news.vercel.app/api/inbox-ingest`; verify Cloudflare throw-retry semantics against current docs; subdomain DNS records auto-provisioned + `v=spf1 -all` TXT + DMARC reject TXT on the subdomain.
6. **Catch-all rule → Worker activated LAST.**
7. End-to-end: create a probe address via authed API, owner sends a real email to it, agent verifies the row via read-only `supabase db query` + verdict log line; owner exports 2–3 real `.eml` files → fixtures upgraded (Task 5 duty).

---

## Slice 3B — Inbox UI (PR 2)

### Task 13: `src/lib/inboxData.js` (RLS reads/writes) + permalink module

**Files:**
- Create: `src/lib/inboxData.js`, `src/lib/inboxData.test.js`, `src/lib/inboxPermalink.js`, `src/lib/inboxPermalink.test.js`

**Interfaces:**
- `inboxPermalink.js` (pure, importable everywhere incl. `lib/` tests): `inboxPermalink(id) -> \`${origin}/inbox/message/${id}\`` (origin from `window.location.origin`); `isInboxPermalink(url) -> boolean` matching `/\/inbox\/message\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` — origin-INDEPENDENT so records survive the Phase-4 domain swap.
- `inboxData.js` (all on `supabase` from `src/lib/supabase.js`, `{ error }` checked, throws on error): `listMessages({ limit = 100 })` (metadata columns ONLY — id, from_email, from_name, subject, excerpt, received_at, read_at, web_url, unsubscribe_url, auth_results, size_bytes — never html_body/text_body; live rows, received_at desc); `getMessage(id)` (single row incl. bodies); `markRead(id)`; `removeMessage(id)` (UPDATE deleted_at = now ISO); `clearRead()` (UPDATE deleted_at where read_at not null and deleted_at null); `unreadCount()` (`count: 'exact', head: true`; filters `read_at is null` AND `deleted_at is null` — matches the partial index `user_inbox_messages_unread_idx`, and deleted-but-unread mail must not inflate the tab badge).

- [ ] Steps: failing tests (mock the supabase client chain like `src/lib/sync.js` tests do; pin: list select string contains NO body column; tombstone is UPDATE never DELETE; clearRead filters `read_at not null`; permalink round-trip + rejects `https://evil.test/inbox/message/x` (non-uuid) and sender lookalikes `https://x.test/a?u=/inbox/message/<uuid>` (regex is end-anchored + path-segment shaped)) → FAIL → implement → PASS → commit `feat(3b): inbox client data layer + origin-independent permalinks`.

### Task 14: `src/stores/inboxStore.js` + boot wiring + sign-out

**Files:**
- Create: `src/stores/inboxStore.js`, `src/stores/inboxStore.test.js`
- Modify: `src/stores/authStore.js` (bootstrap + sign-out), `src/stores/authStore.test.js`

**Interfaces:**
- Store state: `{ address, bytesUsed, messageCount, overQuotaSince, deferredCount, messages: [], unreadCount: 0, isLoading, error, addressLoaded }`; actions `bootstrap()` (address GET + unreadCount, swallow-never-throw like `bootstrapPremiumFeeds`), `fetchList()`, `openMessage(id)` (getMessage + markRead + local read_at set + unreadCount decrement — decrement GATED on the local `read_at` having been null: `markRead` is unconditional and re-opening an already-read message must not drive the badge negative; catch `getMessage`'s PGRST116 throw on a miss — purged/foreign id is an exception, not a null), `remove(id)`, `clearRead()`, `requestAddress()`, `regenerateAddress()`, `removeAddress()`, `reset()`. Address API calls ride `src/lib/api.js` conventions with the session JWT (copy how `premiumStore` calls `/api/premium-feeds`).
- authStore: `bootstrapInboxOnAuth()` called at BOTH `initAuth` session-restore and fresh sign-in sites (landmine 20 — mirror `bootstrapPremiumFeeds` exactly, including the failure-swallowing comment); `signOut` gains `useInboxStore.getState().reset()` beside the premium reset.

- [ ] Steps: failing store tests (bootstrap loads address+count; openMessage marks read once; remove tombstones optimistically; reset clears everything) + authStore tests extended for BOTH bootstrap paths and sign-out reset (copy the existing premium-bootstrap test shapes in `src/stores/authStore.test.js`) → FAIL → implement → PASS → full `npm test` → commit `feat(3b): inbox store with auth-boot wiring and sign-out reset`.

### Task 15: Inbox tab + list UI

**Files:**
- Create: `src/pages/InboxPage.jsx`, `src/pages/InboxPage.test.jsx`, `src/components/InboxMessageRow.jsx`
- Modify: `src/App.jsx` (route `/inbox`), `src/components/BottomTabBar.jsx` (6th tab `{ to: '/inbox', label: 'Inbox', icon: 'inbox' }`; reduce per-item `px-3` → `px-2` so six fit at 320px), `src/components/ui/Icon.jsx` (add an `inbox` glyph — simple tray path, match existing 22px stroke style)

**Interfaces:**
- Consumes: `useInboxStore`, `useAuthStore`, `PullToRefresh`, `EmptyState`/`SourcePickerEmptyState` styling conventions, design tokens (`var(--bg-surface)` etc. — match `FeedLayout.jsx` inline-style idiom).
- States (spec §7.1, each a test): signed-out → sign-in prompt card; signed-in + `addressLoaded` + no address → "Get your address" card (button → `requestAddress`, then shows address + copy button); address + empty list → onboarding hint with copyable address; list → `InboxMessageRow` (from_name || from_email, subject, excerpt, relative date, unread dot; unverified-sender marker when `auth_results` contains `dmarc=fail`); ≥80% quota (`bytesUsed/MAX` or `messageCount/500`) → banner; `overQuotaSince` set → "Inbox full — N deferred since <date>" state; `deferredCount > 0` → deferred note. Refresh: `fetchList` on mount, on window `focus` listener, and via PullToRefresh (`fetchList` also refreshes `unreadCount` server-side — T14 fix-round addition — so focus refetch keeps the tab badge honest). Unread badge on the tab: `BottomTabBar` reads `useInboxStore((s) => s.unreadCount)` and renders a dot when > 0 (subscribe reactively — the FeedLayout comment at line 23 explains why snapshots miss updates). T14 review rulings that bind T15: `addressLoaded` is NOT a loading flag (never-ran / in-flight / ran-and-failed all collapse to `false` — a spinner keyed on `!addressLoaded` spins forever after a failed boot GET; key spinners on `isLoading`, which fires for `fetchList` only); the store surfaces failures via `error` (plain string), and address actions have no spinner signal.
- Quota constants: import MAX values from a new tiny `src/lib/inboxLimits.js` re-export (client can't import `lib/inboxConfig.js` server module directly if it drags Node deps — it doesn't, it's pure consts, so import `lib/inboxConfig.js` directly like `lib/sources.json` is imported today; verify the build).

- [ ] Steps: failing component tests on the in-repo harness (`src/test/domTestUtils.js` — landmine 19; NO @testing-library): one per state above + focus-refetch + badge dot → FAIL → implement → PASS → commit `feat(3b): inbox tab, list, quota surfaces, tab badge`.

### Task 16: Message reader + image blocking + unsubscribe

**Files:**
- Create: `src/pages/InboxMessagePage.jsx`, `src/pages/InboxMessagePage.test.jsx`, `src/styles/email-content.css` (or Tailwind-scoped classes in the page — match how ReaderPage scopes its typography)
- Modify: `src/App.jsx` (route `/inbox/message/:id` wrapped in `ErrorBoundary` like `/article/:id`), `src/lib/sanitize.js` (ADD `sanitizeEmailHtml` client profile — do NOT touch `sanitizeArticleHtml`), `src/stores/settingsStore.js` (+ `alwaysLoadRemoteImages` boolean, default false, persisted like siblings), `src/pages/SettingsPage.jsx` (toggle row)

**Interfaces:**
- Client email profile: `sanitizeEmailHtml(html)` — DOMPurify with `USE_PROFILES: { html: true }`, `FORBID_TAGS: ['iframe','object','embed','form','input','button','svg','math']` (NOTE: `style` ELEMENT stays forbidden; the `style` ATTRIBUTE is allowed — omit it from FORBID_ATTR), `ADD_ATTR: ['target','rel','loading']`.
- Render pipeline in the page: `getMessage` → `sanitizeEmailHtml(html_body)` → if remote images blocked (default; overridden by `alwaysLoadRemoteImages` or per-message "Load images" state): post-process the sanitised DOM string replacing `img src` with `data-masthead-src` + a placeholder background; "Load images (N)" button swaps them back. Fallbacks: no html → `text_body` in `<pre class="whitespace-pre-wrap">`; neither → excerpt + "View original" link (web_url). Email content container: `overflow-x-hidden`, CSS `.email-content table { max-width: 100% !important; width: auto !important; } .email-content img { max-width: 100%; height: auto; }` — 320px is drive-verified.
- Mark-read on mount (via `openMessage`). Header: sender, date, "View original" (web_url, new tab), Unsubscribe button when `unsubscribe_url` — label includes target domain (`new URL(u).hostname` for https; 'mail app' for mailto), `target="_blank" rel="noopener noreferrer"`, never auto-fired. Heart button → Task 17's `saveInboxMessage`.
- Tombstone state (T13 review ruling): `getMessage` deliberately does not filter `deleted_at` (RLS confines rows to their owner), so a deep-linked tombstoned message resolves until the purge cron hard-deletes it. The reader must render a "This message was removed" state when `deleted_at` is set — never the normal reader. Same state covers the `getMessage` miss (PGRST116 throw: already-purged or foreign id) — catch it; it is an exception, not a null.

- [ ] Steps: failing tests (renders sanitised html; style attr survives client profile while `sanitizeArticleHtml` still strips it — BOTH pinned; images blocked by default + toggle reveals + settings opt-in skips blocking; text-only fallback; empty fallback with View-original; unsubscribe label domain; mark-read fired once) → FAIL → implement → PASS → commit `feat(3b): inbox message reader with blocked-by-default remote images`.

### Task 17: Heart-to-library + three-seam extractor ban

**Files:**
- Modify: `src/lib/library.js` (predicate + seams + `saveInboxMessage`), `src/lib/library.test.js`, `src/lib/sync.js` (nothing — but its round-trip is tested), `src/pages/ReaderPage.jsx` ONLY IF its resolution touches inbox permalinks (it must refuse: add the predicate check at the same spot the premium branch sits)

**Interfaces:**
- `src/lib/library.js` additions:

```js
import { isInboxPermalink, inboxPermalink } from './inboxPermalink';

// savedVia does NOT survive a cloud round-trip (localFromSavedRow hardcodes
// 'sync'), so the durable half of this predicate is the URL shape.
export function isInboxRecord(rec) {
  return rec?.savedVia === 'inbox' || isInboxPermalink(rec?.url || '');
}

export async function saveInboxMessage(message) {
  const url = inboxPermalink(message.id);
  return saveArticle(url, {
    savedVia: 'inbox',
    preloadedArticle: {
      title: message.subject || '(no subject)',
      byline: message.from_name || message.from_email,
      content: message.html_body || null,
      textContent: message.text_body || null,
      excerpt: message.excerpt || null,
    },
  });
}
```

(Adapt the exact `saveArticle` option names to the real signature in `src/lib/library.js` — read it first; `preloadedArticle` must route through the existing `capContent` clamp and id derivation `articleId(url)`.)
- Seam guards, each an early return BEFORE any extract call: `saveArticle`'s extract branch, `retrySave`, `attachBodyToSaved` — condition `isInboxRecord(record)`; ReaderPage resolution returns the stored/shell mode for inbox records.

- [ ] Steps: failing tests — (1) `saveInboxMessage` produces a record with permalink url + `articleId(permalink)` id and content, `isCloudSyncable(record)` === true; (2) **round-trip direction:** take that record → `savedRowFromLocal` → `localFromSavedRow` (savedVia becomes 'sync') → assert `retrySave` and `attachBodyToSaved` still refuse it (`extract` spy `not.toHaveBeenCalled()` — the landmine-18 pin, all three seams); (3) hostile `web_url` never appears anywhere in the saved record; (4) un-heart tombstones (`removeSaved` path works now that url passes the CHECK); (5) body-less inbox shell round-trip refuses extraction. → FAIL → implement → PASS → commit `feat(3b): inbox saves with minted permalinks; extractor ban survives sync round-trip`.

### Task 18: Settings section + in-app confirm

**Files:**
- Create: `src/components/ConfirmSheet.jsx`, `src/components/ConfirmSheet.test.jsx`
- Modify: `src/pages/SettingsPage.jsx` (+ "Email Inbox" section), `src/pages/SettingsPage.test.jsx` if present (else cover via component tests)

**Interfaces:**
- `ConfirmSheet({ open, title, message, confirmLabel, danger, onConfirm, onCancel })` — in-app modal (landmine 22: NEVER `window.confirm`), tokens-styled, focus-trapped like `AddSourceModal`'s dialog conventions.
- Settings section: address + copy button; quota meter (`bytesUsed` → "12.4 MB of 100 MB · 87 messages", live values from store); deferred note when `deferredCount > 0`; Regenerate (ConfirmSheet: "This permanently stops mail sent to the old address — update your subscriptions after.") → `regenerateAddress`; Remove (ConfirmSheet) → `removeAddress`. The premium-delete `window.confirm` swap stays PARKED (spec §11) — do not touch `PremiumSourceRow`.

- [ ] Steps: failing tests (confirm fires only on confirm; cancel does nothing; regenerate/remove wired through the sheet; meter formats MB with one decimal from bytes) → FAIL → implement → PASS → commit `feat(3b): inbox settings with in-app confirm component`.

### Task 19: 3B gates + PR

- [ ] Full gates (exact counts, exit codes, zero-new lint), plus `npx vitest run lib/` untouched-server sanity.
- [ ] PR `feat(3b): newsletter inbox UI`, checks, merge on green, verify deployed SHA.

### Task 20: Live drive + close-out (orchestrator, in-session)

- [ ] Spec §9 drive on masthead-news.vercel.app in the owner's Chrome (claude-in-chrome MCP; screenshots may wedge — fall back to DOM/JS assertions per house pattern; premium-row deletes via API if touched — landmine 22): full sequence incl. 320px table check, images blocked→loaded, no `/api/extract` in the network log for inbox opens/saves, second-session heart round-trip, meter-falls-instantly on delete, regenerate → old address bounces (owner sends the probe mail), drive-log equality `bytesUsed === sum(size_bytes)` via read-only db query.
- [ ] Log sweep: Vercel runtime logs for the drive window — verdict lines only, no body/subject/slug content.
- [ ] AGENTS.md (same PR or docs PR): landmine 18 amendment (inbox rule + savedVia-not-durable fact + latent premium note), new bytes-vs-chars landmine, gates baseline update; AGENT_LEARNINGS entries if any incident occurred; auto-memory update; `/save-session`.

---

## Self-review record (plan author, 2026-07-31)

- Spec coverage: §3 verdict table → T7/T10; §4 → T1; §5.1 → T2/T3/T4/T5/T6/T7; §5.2 → T8; §5.3 → T9; §5.4 → T7/T8/T9 mirrors + T11 dev loop; §6 → T1 trigger + T7 ladder + T15 surfaces; §7.1 → T15; §7.2 → T14; §7.3 → T16/T17; §7.4 → T18; §8.1/§10.2 → T12; §8.3 → T4/T16; §9 probes → T1/T12; §9 drive → T20. Gap check: none found.
- Placeholder scan: T16's `saveArticle` option-name adaptation and T7's Vercel raw-body verification are explicitly bounded verify-first steps, not deferrals; no TBDs remain.
- Type consistency: verdict codes identical in T7 and T10; repo verb names identical in T6/T7/T8; permalink module names identical in T13/T17; config constant names identical in T2/T7/T9/T15.
