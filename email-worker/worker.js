// email-worker/worker.js — Cloudflare Email Worker entry point (spec §3).
// Deliberately dumb: forwards the raw RFC-822 bytes to Masthead's
// /api/inbox-ingest unmodified and maps the JSON verdict to an Email
// Routing action. It must NEVER parse mail -- all intelligence (recipient
// lookup, rate limiting, dedupe, sanitising, quota) lives in the API
// (Task 7). All mappable decision logic lives in the pure, vitest-covered
// handler.js; this file only does I/O and is intentionally not
// unit-tested (thin shell).
import { verdictFromResponse, REJECT_CODES } from './handler.js';

// Source of truth: lib/inboxConfig.js MAX_RAW_BYTES (10 MB). This Worker is
// a separate Cloudflare deployable and cannot import from lib/ (a Vercel
// serverless bundle), so the value is duplicated here by hand -- keep it in
// sync if inboxConfig.js ever changes. Exported (a pure constant export
// doesn't compromise the thin-shell/not-unit-tested rule for the email()
// handler itself) so maxRawBytes.test.js can assert parity against
// lib/inboxConfig.js and fail loud the moment the two values drift -- a
// drift where the lib value rises would otherwise leave the Worker
// permanently bouncing "Message too large" on mail the API would accept,
// the exact class of wrongful bounce the no-bounce posture forbids.
export const MAX_RAW_BYTES = 10 * 1024 * 1024;

export default {
  async email(message, env, _ctx) {
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject(REJECT_CODES.message_too_large);
      return;
    }

    const body = await new Response(message.raw).arrayBuffer();

    const response = await fetch(env.INGEST_URL, {
      method: 'POST',
      headers: {
        'x-ingest-secret': env.INGEST_SECRET,
        'x-envelope-to': message.to,
        'x-envelope-from': message.from,
        'content-type': 'application/octet-stream',
      },
      body,
    });

    let bodyJson;
    try {
      bodyJson = await response.json();
    } catch {
      bodyJson = {};
    }

    const verdict = verdictFromResponse(response.status, response.headers, bodyJson);

    if (verdict.action === 'accept') {
      return;
    }

    if (verdict.action === 'reject') {
      message.setReject(verdict.reason);
      return;
    }

    // defer: throw = transient per spec §3 -- Cloudflare's throw-retry
    // semantics are VERIFIED against current docs/behaviour during Task 12,
    // before the catch-all rule is activated (see README.md).
    // Optional chaining: `response.json()` on a literal `null` body parses
    // successfully (valid JSON), so the catch above never fires and
    // bodyJson is `null` here -- `bodyJson.code` would throw a TypeError
    // and lose the diagnostic (though the outcome, a thrown error, is the
    // same either way).
    throw new Error('deferred: ' + (bodyJson?.code || response.status));
  },
};
