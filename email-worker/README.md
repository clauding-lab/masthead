# email-worker — masthead-email-ingest

A Cloudflare Email Worker. Deliberately dumb: Cloudflare Email Routing hands
it raw RFC-822 bytes for mail sent to `*@masthead.clauding-lab.com`; it
forwards them **unmodified** to Masthead's `POST /api/inbox-ingest`
(`api/inbox-ingest.mjs`) and maps the JSON verdict to an Email Routing
action (`message.setReject(...)` or a `throw`, or nothing on accept). It
never parses mail — all intelligence (recipient lookup, rate limiting,
dedupe, sanitising, quota) lives in the API. See
`docs/superpowers/specs/2026-07-30-phase3-email-ingestion-design.md` §3 for
the full SMTP response mapping this Worker implements.

## Files

- `handler.js` — pure verdict-mapping logic (`verdictFromResponse`,
  `REJECT_CODES`). No fetch, no env access. vitest-covered.
- `handler.test.js` — every §3 verdict row + the foreign-response
  protection cases (see `handler.js`'s header comment).
- `worker.js` — the actual Cloudflare `email(message, env, ctx)` entry
  point. Thin I/O shell; not unit-tested by design (nothing here is worth
  mocking `fetch`/`Response`/`message` for — the decision logic it defers
  to is what's tested). It does export a `MAX_RAW_BYTES` constant, tested by
  `maxRawBytes.test.js` (see below) — that one export doesn't compromise the
  thin-shell/not-unit-tested rule for the `email()` handler itself.
- `maxRawBytes.test.js` — parity check: `worker.js`'s `MAX_RAW_BYTES` export
  must equal `lib/inboxConfig.js`'s. See the section below.
- `wrangler.toml` — Worker config. `INGEST_URL` is a plaintext var;
  `INGEST_SECRET` is a secret and is **never** in this file.

## `MAX_RAW_BYTES`

`worker.js` defines its own `MAX_RAW_BYTES = 10 * 1024 * 1024` constant.
This Worker is a separate Cloudflare deployable — it cannot `import` from
this repo's `lib/` (that's a Vercel serverless bundle) — so the value is
duplicated by hand. **`lib/inboxConfig.js`'s `MAX_RAW_BYTES` is the source
of truth.** The sync between the two is **test-enforced, not honour-system**:
`maxRawBytes.test.js` imports both constants and asserts equality, so a drift
fails the suite instead of silently letting the Worker's pre-gate diverge
from what the API would actually accept. If the lib value ever changes,
update `worker.js` to match and let the test confirm it.

## Deploy sequence

Run from inside `email-worker/`:

```sh
wrangler deploy
wrangler secret put INGEST_SECRET
```

`INGEST_URL` is already set as a `[vars]` entry in `wrangler.toml`
(`https://masthead-news.vercel.app/api/inbox-ingest`) — update it there if
the deploy URL ever changes, then re-run `wrangler deploy`.

This deploy only creates the Worker. The subdomain's Email Routing
**catch-all rule must be activated LAST**, after the deploy above and after
the verification step in the next section — activating it first would point
live inbound mail at a Worker still being wired up. Owner-gated infra work
(DNS, SPF/DMARC, the catch-all rule itself) happens as its own step; see the
plan's Task 12.

## Task-12 verification caveat (read before activating the catch-all)

Three things this repo's unit tests cannot verify on their own — all three
must be confirmed live during Task 12, before the catch-all rule is
activated:

**(a) Defer = throw = retry, never a bounce.** `worker.js`'s defer path does
`throw new Error(...)` on any transient verdict (429/5xx/an unrecognised or
missing code/a foreign response without `x-masthead-ingest`). The spec's
binding posture is that this throw must translate to Cloudflare **retrying
delivery on the sender's own schedule**, never a permanent bounce. This
repo's tests (`handler.test.js`) verify the *mapping* — status/headers/body →
`{ action: 'defer' }` — but a unit test cannot verify Cloudflare's own
runtime retry behaviour for a thrown error inside `email()`. **That
behaviour must be verified against current Cloudflare Email Workers docs
(and ideally a live throw-and-observe test) during Task 12.** If Cloudflare's
actual behaviour on a thrown `Error` ever turns out to differ from
"retry, don't bounce" (a platform change, a documented exception for some
error type, etc.), the defer branch in `worker.js` needs to change to
whatever Cloudflare's supported "please retry" mechanism is at that time —
do not assume this file's `throw` is correct without that check.

**(b) Accept = a bare `return` = accept-and-discard.** `worker.js`'s
`verdict.action === 'accept'` branch does a plain `return` with no call to
`message.setReject`/`message.forward`/`message.reply` — this governs 100% of
legitimate mail (every `accepted`/`duplicate` verdict). The assumption is
that Cloudflare Email Routing treats a `return` with no action taken as
"accept the message and stop processing" (the message is consumed, not
bounced, not left pending). Confirm this against current Cloudflare Email
Workers docs during Task 12 — if a bare `return` ever turns out to mean
something else (e.g. an implicit reject, or falling through to a *further*
routing rule that could re-deliver the message elsewhere), every real
newsletter this Worker accepts is affected, not just an edge case.

**(c) The effective Vercel request-body cap vs. `MAX_RAW_BYTES`.** Measure
the actual request-body size limit `POST /api/inbox-ingest` accepts in
production. If that measured cap is BELOW `MAX_RAW_BYTES` (10MB today),
lower `MAX_RAW_BYTES` in **both** `lib/inboxConfig.js` and
`email-worker/worker.js` to match — `maxRawBytes.test.js` makes the two
files' values one value, so a single edit to `lib/inboxConfig.js` plus the
matching edit here is all the sync requires. Skipping this check risks the
opposite of the Worker's own oversize-rejection intent: the Worker accepts
a message under 10MB and forwards it, but the API silently rejects the
oversized body before `lib/inboxIngest.js` ever runs — the Worker's `fetch`
gets a response with no `x-masthead-ingest` header, `handler.js`'s
foreign-response protection correctly defers it, and the sender's mail sits
in an invisible defer loop instead of getting the honest 413 `message_too_large`
NDR `lib/inboxIngest.js` would give it if the raw bytes had been rejected
pre-gate, at the Worker, in the first place.

## Dev-loop smoke test (no deployed Worker needed)

This proves the API side of the contract — routing, auth, and the parse
path — without a DB, by calling `server.js`'s dev mirror of
`/api/inbox-ingest` directly with a real fixture `.eml`. Verified live while
building this Worker:

```sh
INGEST_SECRET=dev npm run dev:api
# in another shell:
curl -i -X POST http://localhost:3001/api/inbox-ingest \
  -H 'x-ingest-secret: dev' \
  -H 'x-envelope-to: reader@inbox.masthead.news' \
  --data-binary @lib/__fixtures__/email/substack.eml
```

Expected (and observed) response:

```
HTTP/1.1 404 Not Found
x-masthead-ingest: 1
content-type: application/json

{"code":"unknown_recipient"}
```

This is the correct verdict with no Supabase or Upstash credentials
configured: the fixture's envelope domain (`inbox.masthead.news`) doesn't
match `INGEST_DOMAIN` (`masthead.clauding-lab.com` — `lib/inboxConfig.js`),
so `lib/inboxIngest.js` resolves it as `unknown_recipient` before ever
touching the database (`lib/rateLimit.js` also degrades gracefully to an
in-memory limiter when Upstash isn't configured, so nothing here needs a
live backend). Feeding it a `masthead.clauding-lab.com` address with no
matching row in the DB would take the same `unknown_recipient` path via
`findAddressBySlug` returning `null` — this fixture just proves the whole
chain without needing any credentials at all. Per `verdictFromResponse`,
`unknown_recipient` maps to `{ action: 'reject', reason: 'No such
recipient' }` — a real Worker run against this response would call
`message.setReject('No such recipient')`.
