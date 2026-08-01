import { describe, it, expect } from 'vitest';
import { verdictFromResponse, REJECT_CODES } from './handler.js';

// handler.js only ever calls `.get(name)` on this argument — exactly what a
// real fetch Response's `.headers` (a WHATWG Headers instance) exposes, in
// both the Cloudflare Workers runtime and Node's undici. A minimal fake
// with just `.get` is enough to exercise the real contract without pulling
// in a runtime global.
function headersWith(ingestValue) {
  return {
    get(name) {
      if (name === 'x-masthead-ingest') return ingestValue ?? null;
      return null;
    },
  };
}

const OUR_HEADERS = headersWith('1');
const NO_HEADERS = headersWith(undefined);

describe('REJECT_CODES', () => {
  it('exposes exactly the four permanent-bounce reasons from spec §3', () => {
    expect(REJECT_CODES).toEqual({
      unknown_recipient: 'No such recipient',
      message_too_large: 'Message too large',
      unparseable: 'Message could not be processed',
      over_quota_final: 'Recipient mailbox is full',
    });
  });
});

describe('verdictFromResponse — §3 verdict rows (authenticated, x-masthead-ingest present)', () => {
  it('201 accepted -> accept', () => {
    expect(verdictFromResponse(201, OUR_HEADERS, { code: 'accepted' })).toEqual({
      action: 'accept',
    });
  });

  it('200 duplicate -> accept', () => {
    expect(verdictFromResponse(200, OUR_HEADERS, { code: 'duplicate' })).toEqual({
      action: 'accept',
    });
  });

  it('404 unknown_recipient -> reject "No such recipient"', () => {
    expect(verdictFromResponse(404, OUR_HEADERS, { code: 'unknown_recipient' })).toEqual({
      action: 'reject',
      reason: 'No such recipient',
    });
  });

  it('413 message_too_large -> reject "Message too large"', () => {
    expect(verdictFromResponse(413, OUR_HEADERS, { code: 'message_too_large' })).toEqual({
      action: 'reject',
      reason: 'Message too large',
    });
  });

  it('422 unparseable -> reject "Message could not be processed"', () => {
    expect(verdictFromResponse(422, OUR_HEADERS, { code: 'unparseable' })).toEqual({
      action: 'reject',
      reason: 'Message could not be processed',
    });
  });

  it('507 over_quota_final -> reject "Recipient mailbox is full"', () => {
    expect(verdictFromResponse(507, OUR_HEADERS, { code: 'over_quota_final' })).toEqual({
      action: 'reject',
      reason: 'Recipient mailbox is full',
    });
  });

  it('429 over_quota (within grace) -> defer, never reject', () => {
    expect(verdictFromResponse(429, OUR_HEADERS, { code: 'over_quota' })).toEqual({
      action: 'defer',
    });
  });

  it('429 rate_limited -> defer', () => {
    expect(verdictFromResponse(429, OUR_HEADERS, { code: 'rate_limited' })).toEqual({
      action: 'defer',
    });
  });

  it('429 disabled -> defer', () => {
    expect(verdictFromResponse(429, OUR_HEADERS, { code: 'disabled' })).toEqual({
      action: 'defer',
    });
  });

  it('401 unauthorized (our own misconfig) -> defer, never a permanent bounce', () => {
    expect(verdictFromResponse(401, OUR_HEADERS, { code: 'unauthorized' })).toEqual({
      action: 'defer',
    });
  });

  it('500 internal_error -> defer', () => {
    expect(verdictFromResponse(500, OUR_HEADERS, { code: 'internal_error' })).toEqual({
      action: 'defer',
    });
  });

  it('405 method_not_allowed (route misconfig) -> defer', () => {
    expect(verdictFromResponse(405, OUR_HEADERS, { code: 'method_not_allowed' })).toEqual({
      action: 'defer',
    });
  });

  it('an unrecognised future code, even at 2xx -> defer, not a blind accept', () => {
    expect(verdictFromResponse(200, OUR_HEADERS, { code: 'quarantined_experimental' })).toEqual({
      action: 'defer',
    });
  });
});

describe('verdictFromResponse — foreign-response protection (spec §3 verdict authentication)', () => {
  it('a bare 200 with NO x-masthead-ingest header -> defer, never accept, even with an accepted-shaped body', () => {
    expect(verdictFromResponse(200, NO_HEADERS, { code: 'accepted' })).toEqual({
      action: 'defer',
    });
  });

  it('a bare 201 with NO header -> defer, never accept', () => {
    expect(verdictFromResponse(201, NO_HEADERS, { code: 'accepted' })).toEqual({
      action: 'defer',
    });
  });

  it('404 with NO header -> defer, never reject, even with an unknown_recipient-shaped body', () => {
    expect(verdictFromResponse(404, NO_HEADERS, { code: 'unknown_recipient' })).toEqual({
      action: 'defer',
    });
  });

  it('an HTML interstitial body (JSON parse failed upstream, worker.js hands us {}) -> defer', () => {
    expect(verdictFromResponse(200, NO_HEADERS, {})).toEqual({ action: 'defer' });
  });

  it('undefined bodyJson -> defer, does not throw', () => {
    expect(verdictFromResponse(200, NO_HEADERS, undefined)).toEqual({ action: 'defer' });
  });

  it('our own header present but body has no code (malformed/empty JSON) -> defer, not a blind accept on 2xx', () => {
    expect(verdictFromResponse(200, OUR_HEADERS, {})).toEqual({ action: 'defer' });
  });

  it('our own header present but bodyJson is undefined -> defer, does not throw', () => {
    expect(verdictFromResponse(201, OUR_HEADERS, undefined)).toEqual({ action: 'defer' });
  });

  it('headers object missing a usable .get (defensive: not a real fetch Headers) -> defer, does not throw', () => {
    expect(verdictFromResponse(200, { 'x-masthead-ingest': '1' }, { code: 'accepted' })).toEqual({
      action: 'defer',
    });
  });

  it('null headers -> defer, does not throw', () => {
    expect(verdictFromResponse(200, null, { code: 'accepted' })).toEqual({ action: 'defer' });
  });
});
