// email-worker/handler.js — pure verdict-mapping logic for the
// masthead-email-ingest Cloudflare Email Worker (spec §3, SMTP response
// mapping table). No fetch, no env access: takes the already-fetched
// response's status/headers/parsed-body and returns what the Worker should
// do. worker.js is the only thing that talks to the network; every mappable
// decision lives here so it's vitest-covered.
//
// Verdict authentication (spec §3, red-team ops): a response is trusted as
// OUR verdict only when it carries the `x-masthead-ingest: 1` header. Every
// action -- including accept -- is gated on that header. Without it (a bare
// platform 404, a WAF interstitial, a misrouted INGEST_URL, a proxy page)
// the response could be from anything but our own /api/inbox-ingest, so the
// only safe action is to defer and let the sender's own retry schedule
// recover.
//
// Beyond the header gate, accept/reject additionally require a *recognised*
// code in the parsed body -- an authenticated response with a missing or
// unrecognised code (malformed JSON, a future code this Worker doesn't know
// about yet) still defers rather than guessing. The binding posture is that
// no infra condition may permanently bounce legitimate mail, and no
// ambiguous response may be silently treated as delivered either.

const INGEST_HEADER = 'x-masthead-ingest';

// spec §3: the only four codes that produce a permanent bounce (NDR). Every
// other code from the API -- including `over_quota`/`rate_limited`/
// `disabled` (all transient 429s) and `internal_error`/`unauthorized`
// (infra/config faults) -- falls through to defer below.
export const REJECT_CODES = {
  unknown_recipient: 'No such recipient',
  message_too_large: 'Message too large',
  unparseable: 'Message could not be processed',
  over_quota_final: 'Recipient mailbox is full',
};

// spec §3: the only two codes that mean "delivered" (2xx accepted / 2xx
// duplicate). Not exported -- REJECT_CODES is the only code vocabulary the
// interface promises; this is an internal detail of the accept branch.
const ACCEPT_CODES = new Set(['accepted', 'duplicate']);

function hasIngestHeader(headers) {
  if (!headers || typeof headers.get !== 'function') return false;
  return headers.get(INGEST_HEADER) === '1';
}

function codeOf(bodyJson) {
  if (!bodyJson || typeof bodyJson !== 'object') return undefined;
  return bodyJson.code;
}

/**
 * @param {number} status - HTTP status of the /api/inbox-ingest response.
 * @param {{ get(name: string): string | null }} headers - the response's
 *   headers (a fetch `Response.headers`, or anything else exposing `.get`).
 * @param {unknown} bodyJson - the parsed JSON body, or `{}`/`undefined` when
 *   parsing failed or produced something other than an object.
 * @returns {{ action: 'accept' | 'reject' | 'defer', reason?: string }}
 */
export function verdictFromResponse(status, headers, bodyJson) {
  if (!hasIngestHeader(headers)) {
    return { action: 'defer' };
  }

  const code = codeOf(bodyJson);

  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(REJECT_CODES, code)) {
    return { action: 'reject', reason: REJECT_CODES[code] };
  }

  if (status >= 200 && status < 300 && typeof code === 'string' && ACCEPT_CODES.has(code)) {
    return { action: 'accept' };
  }

  return { action: 'defer' };
}
