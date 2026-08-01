import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ingestEmail } from './inboxIngest.js';
import { MAX_RAW_BYTES, MAX_MESSAGE_BYTES } from './inboxConfig.js';

// Built via fromCharCode, never typed literally, and never spelled out as a
// Unicode escape sequence either — same transcription-hazard rule as
// lib/inboxIngest.js and lib/emailParse.test.js.
const NUL = String.fromCharCode(0);

const VALID_DOMAIN = 'masthead.clauding-lab.com';
const SLUG = 'quiet-harbor-4f2a';
const VALID_ENVELOPE = `Quiet-Harbor-4f2a@${VALID_DOMAIN}`;
const RAW_BUFFER = Buffer.from('raw email bytes');
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const ADDRESS = { id: 'addr-1', userId: 'user-1', overQuotaSince: null };

const PARSED = {
  fromEmail: 'sender@example.com',
  fromName: 'Sender Name',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  messageId: '<abc@example.com>',
  webUrl: 'https://example.com/view',
  unsubscribeUrl: 'https://example.com/unsub',
  authResults: 'spf=pass',
  dedupeKey: 'dedupe-key-1',
};

function makeRepo(overrides = {}) {
  return {
    findAddressBySlug: vi.fn().mockResolvedValue(
      overrides.address === undefined ? ADDRESS : overrides.address
    ),
    insertMessage: vi.fn().mockResolvedValue(overrides.insertVerdict ?? 'inserted'),
    markDeferred: vi.fn().mockResolvedValue(undefined),
    clearDeferred: vi.fn().mockResolvedValue(undefined),
    // Never called by ingestEmail — case 14 pins that.
    getAddressRow: vi.fn(),
    ensureAddress: vi.fn(),
    rotateSlug: vi.fn(),
    disableSlug: vi.fn(),
    quotaSnapshot: vi.fn(),
  };
}

// A fresh mock per call (never a shared module-level singleton) — tests
// that assert on limiter call args/counts must not see calls bleed in from
// unrelated tests or from other ingestEmail() calls within the same test.
function makeAllowAllLimiter() {
  return vi.fn().mockResolvedValue({ allowed: true });
}

function happyDeps(repo, overrides = {}) {
  return {
    repo,
    parse: overrides.parse ?? vi.fn().mockResolvedValue(PARSED),
    sanitize: overrides.sanitize ?? vi.fn().mockResolvedValue('<p>Hi</p>'),
    limiter: overrides.limiter ?? makeAllowAllLimiter(),
    now: overrides.now ?? (() => NOW),
  };
}

function happyInput(overrides = {}) {
  return { envelopeTo: VALID_ENVELOPE, rawBuffer: RAW_BUFFER, ...overrides };
}

// verdict() is the sole enforcement point for the log-privacy rule (spec §8
// rule 5: never log slug/subject/body) and for "exactly ONE line per
// message." Spying (not just silencing) lets tests assert both properties
// directly, and keeps [ingest] … noise out of every other test's stdout —
// matching lib/premiumService.test.js / api/premium-feeds.test.js, which
// both spy console for the same reason.
let consoleLogSpy;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.INGEST_DISABLED;
  consoleLogSpy.mockRestore();
});

describe('ingestEmail — spec §3 verdict table', () => {
  it('case 1: unknown slug -> 404 unknown_recipient; parse never called; consumes the inbox:unknown bucket', async () => {
    const repo = makeRepo({ address: null });
    const parse = vi.fn();
    const limiter = makeAllowAllLimiter();
    const result = await ingestEmail(happyInput(), happyDeps(repo, { parse, limiter }));
    expect(result).toEqual({ status: 404, code: 'unknown_recipient' });
    expect(repo.findAddressBySlug).toHaveBeenCalledWith(SLUG);
    expect(parse).not.toHaveBeenCalled();
    expect(limiter).toHaveBeenCalledWith('inbox:unknown', { limit: 120, windowSec: 3600 });
  });

  it('case 2: INGEST_DISABLED=1 -> 429 disabled; repo untouched', async () => {
    process.env.INGEST_DISABLED = '1';
    const repo = makeRepo();
    const result = await ingestEmail(happyInput(), happyDeps(repo));
    expect(result).toEqual({ status: 429, code: 'disabled' });
    expect(repo.findAddressBySlug).not.toHaveBeenCalled();
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });

  it('case 3: limiter denies -> 429 rate_limited; parse never called', async () => {
    const repo = makeRepo();
    const parse = vi.fn();
    const limiter = vi.fn().mockResolvedValue({ allowed: false });
    const result = await ingestEmail(happyInput(), happyDeps(repo, { parse, limiter }));
    expect(result).toEqual({ status: 429, code: 'rate_limited' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('case 4: raw size over MAX_RAW_BYTES -> 413 message_too_large; parse never called', async () => {
    const repo = makeRepo();
    const parse = vi.fn();
    const bigBuffer = Buffer.alloc(MAX_RAW_BYTES + 1);
    const result = await ingestEmail(
      happyInput({ rawBuffer: bigBuffer }),
      happyDeps(repo, { parse })
    );
    expect(result).toEqual({ status: 413, code: 'message_too_large' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('case 5: parse returns null -> 422 unparseable', async () => {
    const repo = makeRepo();
    const parse = vi.fn().mockResolvedValue(null);
    const result = await ingestEmail(happyInput(), happyDeps(repo, { parse }));
    expect(result).toEqual({ status: 422, code: 'unparseable' });
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });

  it('case 6: sanitized size over MAX_MESSAGE_BYTES -> 413 message_too_large', async () => {
    const repo = makeRepo();
    const bigHtml = 'x'.repeat(MAX_MESSAGE_BYTES + 1);
    const sanitize = vi.fn().mockResolvedValue(bigHtml);
    const result = await ingestEmail(happyInput(), happyDeps(repo, { sanitize }));
    expect(result).toEqual({ status: 413, code: 'message_too_large' });
    expect(repo.insertMessage).not.toHaveBeenCalled();
  });

  it('case 7: insertMessage duplicate -> 200 duplicate; markDeferred NOT called', async () => {
    const repo = makeRepo({ insertVerdict: 'duplicate' });
    const result = await ingestEmail(happyInput(), happyDeps(repo));
    expect(result).toEqual({ status: 200, code: 'duplicate' });
    expect(repo.markDeferred).not.toHaveBeenCalled();
    expect(repo.clearDeferred).not.toHaveBeenCalled();
  });

  it('case 8: insertMessage inserted -> 201 accepted; clearDeferred called', async () => {
    const repo = makeRepo({ insertVerdict: 'inserted' });
    const result = await ingestEmail(happyInput(), happyDeps(repo));
    expect(result).toEqual({ status: 201, code: 'accepted' });
    expect(repo.clearDeferred).toHaveBeenCalledWith(ADDRESS.userId);
    expect(repo.markDeferred).not.toHaveBeenCalled();
  });

  it('case 9: over_quota with overQuotaSince null -> 429 over_quota; markDeferred called', async () => {
    const repo = makeRepo({
      address: { ...ADDRESS, overQuotaSince: null },
      insertVerdict: 'over_quota',
    });
    const result = await ingestEmail(happyInput(), happyDeps(repo));
    expect(result).toEqual({ status: 429, code: 'over_quota' });
    expect(repo.markDeferred).toHaveBeenCalledWith(ADDRESS.userId);
  });

  it('case 10: over_quota with overQuotaSince 3 days ago -> 429 over_quota (within grace)', async () => {
    const since = new Date(NOW - 3 * DAY_MS).toISOString();
    const repo = makeRepo({
      address: { ...ADDRESS, overQuotaSince: since },
      insertVerdict: 'over_quota',
    });
    const result = await ingestEmail(happyInput(), happyDeps(repo));
    expect(result).toEqual({ status: 429, code: 'over_quota' });
    expect(repo.markDeferred).toHaveBeenCalledWith(ADDRESS.userId);
  });

  it('case 11: over_quota with overQuotaSince 8 days ago -> 507 over_quota_final', async () => {
    const since = new Date(NOW - 8 * DAY_MS).toISOString();
    const repo = makeRepo({
      address: { ...ADDRESS, overQuotaSince: since },
      insertVerdict: 'over_quota',
    });
    const result = await ingestEmail(happyInput(), happyDeps(repo));
    expect(result).toEqual({ status: 507, code: 'over_quota_final' });
    expect(repo.markDeferred).toHaveBeenCalledWith(ADDRESS.userId);
  });

  it('case 12: local-part normalisation strips +suffix and lowercases before slug lookup', async () => {
    const repo = makeRepo();
    const result = await ingestEmail(
      happyInput({ envelopeTo: `Quiet-Harbor-4f2a+tag@${VALID_DOMAIN}` }),
      happyDeps(repo)
    );
    expect(repo.findAddressBySlug).toHaveBeenCalledWith(SLUG);
    expect(result.code).toBe('accepted');
  });

  it('case 13: envelopeTo on the wrong domain -> 404 unknown_recipient; consumes the inbox:unknown bucket', async () => {
    const repo = makeRepo();
    const limiter = makeAllowAllLimiter();
    const result = await ingestEmail(
      happyInput({ envelopeTo: `${SLUG}@not-our-domain.example.com` }),
      happyDeps(repo, { limiter })
    );
    expect(result).toEqual({ status: 404, code: 'unknown_recipient' });
    expect(repo.findAddressBySlug).not.toHaveBeenCalled();
    expect(limiter).toHaveBeenCalledWith('inbox:unknown', { limit: 120, windowSec: 3600 });
  });

  it('case 14: INSERT-only pin — running cases 1-11 never touches repo beyond findAddressBySlug/insertMessage/markDeferred/clearDeferred', async () => {
    const repo = makeRepo();

    // case 1: unknown slug
    repo.findAddressBySlug.mockResolvedValueOnce(null);
    await ingestEmail(happyInput(), happyDeps(repo));

    // case 2: disabled
    process.env.INGEST_DISABLED = '1';
    await ingestEmail(happyInput(), happyDeps(repo));
    delete process.env.INGEST_DISABLED;

    // case 3: rate limited
    await ingestEmail(
      happyInput(),
      happyDeps(repo, { limiter: vi.fn().mockResolvedValue({ allowed: false }) })
    );

    // case 4: raw too large
    await ingestEmail(
      happyInput({ rawBuffer: Buffer.alloc(MAX_RAW_BYTES + 1) }),
      happyDeps(repo)
    );

    // case 5: unparseable
    await ingestEmail(happyInput(), happyDeps(repo, { parse: vi.fn().mockResolvedValue(null) }));

    // case 6: sanitized too large
    await ingestEmail(
      happyInput(),
      happyDeps(repo, { sanitize: vi.fn().mockResolvedValue('x'.repeat(MAX_MESSAGE_BYTES + 1)) })
    );

    // case 7: duplicate
    repo.insertMessage.mockResolvedValueOnce('duplicate');
    await ingestEmail(happyInput(), happyDeps(repo));

    // case 8: accepted
    repo.insertMessage.mockResolvedValueOnce('inserted');
    await ingestEmail(happyInput(), happyDeps(repo));

    // case 9: over_quota, overQuotaSince null (first defer)
    repo.findAddressBySlug.mockResolvedValueOnce({ ...ADDRESS, overQuotaSince: null });
    repo.insertMessage.mockResolvedValueOnce('over_quota');
    await ingestEmail(happyInput(), happyDeps(repo));

    // case 10: over_quota, overQuotaSince 3 days ago (within the 7-day grace)
    repo.findAddressBySlug.mockResolvedValueOnce({
      ...ADDRESS,
      overQuotaSince: new Date(NOW - 3 * DAY_MS).toISOString(),
    });
    repo.insertMessage.mockResolvedValueOnce('over_quota');
    await ingestEmail(happyInput(), happyDeps(repo));

    // case 11: over_quota, overQuotaSince 8 days ago (beyond the 7-day grace)
    repo.findAddressBySlug.mockResolvedValueOnce({
      ...ADDRESS,
      overQuotaSince: new Date(NOW - 8 * DAY_MS).toISOString(),
    });
    repo.insertMessage.mockResolvedValueOnce('over_quota');
    await ingestEmail(happyInput(), happyDeps(repo));

    // Only insertMessage (plain INSERT), markDeferred, and clearDeferred ever
    // ran a write. No other repo function — every one of which is an
    // update/upsert/delete against user_ingest_addresses or a read — was
    // ever invoked.
    expect(repo.getAddressRow).not.toHaveBeenCalled();
    expect(repo.ensureAddress).not.toHaveBeenCalled();
    expect(repo.rotateSlug).not.toHaveBeenCalled();
    expect(repo.disableSlug).not.toHaveBeenCalled();
    expect(repo.quotaSnapshot).not.toHaveBeenCalled();
  });

  it('case 15: dedupe precedes quota — duplicate verdict wins even though quota would be full, with no pre-quota rejection', async () => {
    const repo = makeRepo({ insertVerdict: 'duplicate' });
    // If ingestEmail ever consulted quota before insertMessage, this would
    // report "full" and a naive implementation might reject before ever
    // reaching insertMessage.
    repo.quotaSnapshot.mockResolvedValue({ messageCount: 999999, bytesUsed: 999999999 });

    const result = await ingestEmail(happyInput(), happyDeps(repo));

    expect(result).toEqual({ status: 200, code: 'duplicate' });
    expect(repo.insertMessage).toHaveBeenCalledTimes(1);
    expect(repo.quotaSnapshot).not.toHaveBeenCalled();
  });

  it('case 16: NUL-strip pin — strips U+0000 from every string field of the row before insertMessage', async () => {
    const repo = makeRepo();
    const parse = vi.fn().mockResolvedValue({
      ...PARSED,
      fromEmail: 'sender' + NUL + '@example.com',
      fromName: 'Sender' + NUL + 'Name',
      subject: 'Hello' + NUL + 'World',
      text: 'Body' + NUL + 'Text',
      html: '<p>Hi</p>',
    });
    // Simulates a sanitizer that (hypothetically) let a NUL through — proves
    // the strip is a row-level backstop, not just a pass-through of
    // sanitizeEmailHtml's own html-only guarantee.
    const sanitize = vi.fn().mockResolvedValue('<p>Hi' + NUL + '</p>');

    const result = await ingestEmail(happyInput(), happyDeps(repo, { parse, sanitize }));

    expect(result.code).toBe('accepted');
    expect(repo.insertMessage).toHaveBeenCalledTimes(1);
    const row = repo.insertMessage.mock.calls[0][0];

    // Sanity: prove the source strings actually carried a NUL, so this test
    // would fail (not pass vacuously) if the strip were removed.
    expect('sender' + NUL + '@example.com').toContain(NUL);

    for (const field of ['fromEmail', 'fromName', 'subject', 'text', 'excerpt', 'html']) {
      expect(row[field], `row.${field} must not contain U+0000`).not.toContain(NUL);
    }
    expect(row.fromEmail).toBe('sender@example.com');
    expect(row.fromName).toBe('SenderName');
    expect(row.subject).toBe('HelloWorld');
    expect(row.text).toBe('BodyText');
  });

  it('case 17: unknown-recipient metering — inbox:unknown bucket denies -> 429 rate_limited instead of 404 (no enumeration feedback)', async () => {
    const repo = makeRepo({ address: null });
    const limiter = vi.fn().mockImplementation(async (key) =>
      key === 'inbox:unknown' ? { allowed: false } : { allowed: true }
    );

    const result = await ingestEmail(happyInput(), happyDeps(repo, { limiter }));

    // A denied bucket must produce the SAME shape as any other rate limit —
    // never a 404, which would tell a slug-enumeration probe "that guess was
    // wrong" as opposed to "you're being throttled."
    expect(result).toEqual({ status: 429, code: 'rate_limited' });
    expect(limiter).toHaveBeenCalledWith('inbox:unknown', { limit: 120, windowSec: 3600 });
  });

  it('case 17: unknown-recipient metering — the same denial applies to the wrong-domain 404 path, not just the unknown-slug path', async () => {
    const repo = makeRepo();
    const limiter = vi.fn().mockImplementation(async (key) =>
      key === 'inbox:unknown' ? { allowed: false } : { allowed: true }
    );

    const result = await ingestEmail(
      happyInput({ envelopeTo: `${SLUG}@not-our-domain.example.com` }),
      happyDeps(repo, { limiter })
    );

    expect(result).toEqual({ status: 429, code: 'rate_limited' });
    expect(repo.findAddressBySlug).not.toHaveBeenCalled();
    expect(limiter).toHaveBeenCalledWith('inbox:unknown', { limit: 120, windowSec: 3600 });
  });

  it('case 17: known-slug traffic never touches the inbox:unknown bucket (discriminating assertion)', async () => {
    const repo = makeRepo(); // default: findAddressBySlug resolves a known address
    const limiter = vi.fn().mockResolvedValue({ allowed: true });

    const result = await ingestEmail(happyInput(), happyDeps(repo, { limiter }));

    expect(result.code).toBe('accepted');
    const unknownBucketCalls = limiter.mock.calls.filter(([key]) => key === 'inbox:unknown');
    expect(unknownBucketCalls).toHaveLength(0);
    // Sanity: the limiter WAS used (for the per-user/global buckets) — this
    // isn't passing because the limiter went entirely unused.
    expect(limiter).toHaveBeenCalledWith(`inbox:${ADDRESS.userId}`, { limit: 60, windowSec: 3600 });
    expect(limiter).toHaveBeenCalledWith('inbox:global', { limit: 1000, windowSec: 3600 });
  });
});

describe('ingestEmail — envelope parsing edge cases', () => {
  it('malformed envelope (no @) -> 404 unknown_recipient', async () => {
    const repo = makeRepo();
    const result = await ingestEmail(happyInput({ envelopeTo: 'not-an-email' }), happyDeps(repo));
    expect(result).toEqual({ status: 404, code: 'unknown_recipient' });
    expect(repo.findAddressBySlug).not.toHaveBeenCalled();
  });
});

describe('ingestEmail — log-line contract (spec §8 rule 5)', () => {
  it('logs the exact [ingest] <code> row=<id> bytes=<n> format on the accepted path', async () => {
    const repo = makeRepo({ insertVerdict: 'inserted' });
    await ingestEmail(happyInput(), happyDeps(repo));

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      `[ingest] accepted row=${ADDRESS.id} bytes=${RAW_BUFFER.length}`
    );
  });

  it('logs row=none (never the slug) when there is no resolved address', async () => {
    const repo = makeRepo({ address: null });
    await ingestEmail(happyInput(), happyDeps(repo));

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      `[ingest] unknown_recipient row=none bytes=${RAW_BUFFER.length}`
    );
  });

  it('logs exactly one line per ingestEmail call, across the early-exit, accepted, and over-quota branches', async () => {
    // Early exit: unknown_recipient — no repo/limiter branching beyond the
    // single unknown-recipient path.
    await ingestEmail(happyInput(), happyDeps(makeRepo({ address: null })));
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    consoleLogSpy.mockClear();

    // Accepted — the multi-step success branch (insertMessage + clearDeferred).
    await ingestEmail(happyInput(), happyDeps(makeRepo({ insertVerdict: 'inserted' })));
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    consoleLogSpy.mockClear();

    // Over-quota — the most branching path (insertMessage + markDeferred +
    // a grace-ladder calculation before the verdict is logged).
    await ingestEmail(happyInput(), happyDeps(makeRepo({ insertVerdict: 'over_quota' })));
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('never logs the slug, subject, or body content, even when they are deliberately distinctive (privacy rule)', async () => {
    const distinctiveSlug = 'zzz-distinctive-slug-marker';
    const distinctiveSubject = 'ZZZ-SECRET-SUBJECT-MARKER';
    const distinctiveBody = 'ZZZ-SECRET-BODY-MARKER';
    const repo = makeRepo({ insertVerdict: 'inserted' });
    const parse = vi
      .fn()
      .mockResolvedValue({ ...PARSED, subject: distinctiveSubject, text: distinctiveBody });

    await ingestEmail(
      happyInput({ envelopeTo: `${distinctiveSlug}@${VALID_DOMAIN}` }),
      happyDeps(repo, { parse })
    );

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const [line] = consoleLogSpy.mock.calls[0];
    expect(line).not.toContain(distinctiveSlug);
    expect(line).not.toContain(distinctiveSubject);
    expect(line).not.toContain(distinctiveBody);
    // Sanity: the log line isn't just empty/generic — it does carry the
    // address id and byte count the format promises.
    expect(line).toBe(`[ingest] accepted row=${ADDRESS.id} bytes=${RAW_BUFFER.length}`);
  });

  it('never logs the slug on the unknown-recipient path either, even for a distinctive unresolved slug', async () => {
    const distinctiveSlug = 'zzz-unknown-slug-marker';
    const repo = makeRepo({ address: null });

    await ingestEmail(
      happyInput({ envelopeTo: `${distinctiveSlug}@${VALID_DOMAIN}` }),
      happyDeps(repo)
    );

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const [line] = consoleLogSpy.mock.calls[0];
    expect(line).not.toContain(distinctiveSlug);
    expect(line).toContain('row=none');
  });
});
