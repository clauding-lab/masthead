import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseEmail } from './emailParse.js';

const load = (n) => readFileSync(new URL(`./__fixtures__/email/${n}`, import.meta.url));

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// Control characters are written as escapes, never as literal bytes — a raw
// NUL or BEL does not survive every editor.
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const hasControlChar = (s) =>
  [...s].some((c) => c.codePointAt(0) < 0x20 || c.codePointAt(0) === 0x7f);

/** Minimal RFC 5322 message, built from parts so header values stay exact. */
function buildEml({ headers, body = 'plain body', contentType = 'text/plain; charset=utf-8' }) {
  const lines = [...headers, 'MIME-Version: 1.0', `Content-Type: ${contentType}`, '', body];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

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

    const base = ['Date: Fri, 3 Jul 2026 22:14:59 -0400', 'From: bot <bot@example.org>', 'Subject: Digest'];
    const one = await parseEmail(buildEml({ headers: base, body: 'first body' }));
    const two = await parseEmail(buildEml({ headers: base, body: 'second body' }));
    expect(one.dedupeKey).not.toBe(two.dedupeKey);
  });

  it('returns null for garbage that is not MIME at all', async () => {
    expect(await parseEmail(Buffer.from([0xff, 0xfe, 0x00]))).toBeNull();
  });

  it('extracts List-Unsubscribe https over mailto when both present', async () => {
    const p = await parseEmail(load('mailchimp.eml'));
    expect(p.unsubscribeUrl).not.toBeNull();
    expect(p.unsubscribeUrl).toBe(
      'https://climatechange.us3.list-manage.com/unsubscribe?u=a5463f28627a77a4b2a79e7d0&id=e28537c7a1&e=8f1c2d4b7a&c=2ac1f0d95e',
    );
  });
});

describe('parseEmail · web version URL', () => {
  it('takes webUrl from the List-Post header when the sender supplies one', async () => {
    const p = await parseEmail(load('substack.eml'));
    expect(p.webUrl).toBe('https://www.construction-physics.com/p/why-is-everyone-trying-to-build-a');
  });

  it('falls back to the real "View this email in your browser" anchor', async () => {
    const p = await parseEmail(load('mailchimp.eml'));
    expect(p.webUrl).toBe(
      'https://mailchi.mp/38d9db61f092/climate-change-ai-newsletter-april-5860160?e=[UNIQID]',
    );
  });

  it('is null when there is neither a List-Post header nor a view-online anchor', async () => {
    const p = await parseEmail(load('beehiiv.eml'));
    expect(p.webUrl).toBeNull();
  });

  it('rejects a non-https List-Post value rather than storing http', async () => {
    const p = await parseEmail(
      buildEml({
        headers: [
          'From: bot <bot@example.org>',
          'Subject: Digest',
          'List-Post: <http://insecure.example.org/issue/1>',
        ],
      }),
    );
    expect(p.webUrl).toBeNull();
  });

  it('decodes &amp; in the anchor href instead of storing a broken link', async () => {
    const p = await parseEmail(
      buildEml({
        headers: ['From: bot <bot@example.org>', 'Subject: Digest'],
        contentType: 'text/html; charset=utf-8',
        body: '<p><a href="https://example.org/v?u=1&amp;id=2&amp;e=3">View this email in your browser</a></p>',
      }),
    );
    expect(p.webUrl).toBe('https://example.org/v?u=1&id=2&e=3');
  });

  it('matches a view-online label that is wrapped in inline tags', async () => {
    const p = await parseEmail(
      buildEml({
        headers: ['From: bot <bot@example.org>', 'Subject: Digest'],
        contentType: 'text/html; charset=utf-8',
        body: '<a href="https://example.org/issue/9"><span>View</span>&nbsp;<b>online</b></a>',
      }),
    );
    expect(p.webUrl).toBe('https://example.org/issue/9');
  });

  it('skips a matching anchor that is not https and keeps scanning', async () => {
    const p = await parseEmail(
      buildEml({
        headers: ['From: bot <bot@example.org>', 'Subject: Digest'],
        contentType: 'text/html; charset=utf-8',
        body:
          '<a href="http://insecure.example.org/a">View online</a>' +
          '<a href="https://secure.example.org/b">View in browser</a>',
      }),
    );
    expect(p.webUrl).toBe('https://secure.example.org/b');
  });

  it('rejects a view-online anchor longer than 4000 characters', async () => {
    const long = `https://example.org/view/${'a'.repeat(4100)}`;
    const p = await parseEmail(
      buildEml({
        headers: ['From: bot <bot@example.org>', 'Subject: Digest'],
        contentType: 'text/html; charset=utf-8',
        body: `<p><a href="${long}">View online</a></p>`,
      }),
    );
    expect(p.webUrl).toBeNull();
  });

  // Regression guard for quadratic backtracking. The trigger is a large
  // label with NO match: greedy `.*` in the old pattern
  // (`/view.*(online|browser)/i`) only backtracks far when it must scan the
  // whole string and still fail, which is what a huge non-matching label
  // forces. (A huge label that DOES match, e.g. with "online" near the end,
  // is a false negative for this test — greedy `.*` finds it on the first
  // attempt in well under a millisecond, so it never exercises the
  // backtracking path at all.) The first anchor below is a 200K-character
  // label with no "online"/"browser" substring — under the old pattern this
  // alone burns ~16s and blows vitest's default 5s test timeout; under the
  // bounded pattern the whole test resolves in ~1ms. The real match lives in
  // a second anchor, so a correct implementation must still find it after
  // failing to match the first.
  it('completes quickly on a pathological non-matching view label and still finds the real match', async () => {
    const noMatchLabel = 'view'.repeat(50000);
    const p = await parseEmail(
      buildEml({
        headers: ['From: bot <bot@example.org>', 'Subject: Digest'],
        contentType: 'text/html; charset=utf-8',
        body:
          `<a href="https://a.example.org/x">${noMatchLabel}</a>` +
          '<a href="https://example.org/issue/1">View online</a>',
      }),
    );
    expect(p.webUrl).toBe('https://example.org/issue/1');
  });
});

describe('parseEmail · unsubscribe URL', () => {
  it('prefers the https entry even when mailto is listed first', async () => {
    const p = await parseEmail(load('beehiiv.eml'));
    expect(p.unsubscribeUrl).toBe('https://elink.therundown.ai/unsubscribe/01000198c4b21f7a');
  });

  it('falls back to the mailto entry when no https entry exists', async () => {
    const p = await parseEmail(
      buildEml({
        headers: [
          'From: bot <bot@example.org>',
          'Subject: Digest',
          'List-Unsubscribe: <mailto:leave@lists.example.org?subject=stop>',
        ],
      }),
    );
    expect(p.unsubscribeUrl).toBe('mailto:leave@lists.example.org?subject=stop');
  });

  it('falls through to a short mailto entry when the https entry exceeds 4000 characters', async () => {
    const oversizedHttps = `https://example.org/unsubscribe/${'a'.repeat(4100)}`;
    const p = await parseEmail(
      buildEml({
        headers: [
          'From: bot <bot@example.org>',
          'Subject: Digest',
          `List-Unsubscribe: <${oversizedHttps}>, <mailto:leave@example.org>`,
        ],
      }),
    );
    expect(p.unsubscribeUrl).toBe('mailto:leave@example.org');
  });

  it('is null when the header is absent', async () => {
    const p = await parseEmail(buildEml({ headers: ['From: bot <bot@example.org>', 'Subject: Digest'] }));
    expect(p.unsubscribeUrl).toBeNull();
  });
});

describe('parseEmail · clamps and control characters', () => {
  it('strips control characters from the subject', async () => {
    const p = await parseEmail(load('pathological.eml'));
    expect(p.subject).toBe('Broken pipeline digest');
    expect(hasControlChar(p.subject)).toBe(false);
  });

  it('clamps subject to 500, fromName to 200 and fromEmail to 320 characters', async () => {
    const longSubject = 'S'.repeat(900);
    const longName = 'N'.repeat(400);
    const longLocal = 'l'.repeat(400);
    const p = await parseEmail(
      buildEml({
        headers: [`From: ${longName} <${longLocal}@example.org>`, `Subject: ${longSubject}`],
      }),
    );
    expect(p.subject).toHaveLength(500);
    expect(p.fromName).toHaveLength(200);
    expect(p.fromEmail).toHaveLength(320);
  });

  it('clamps an oversized Message-ID to 500 characters and uses the clamped value as the dedupe key', async () => {
    const longLocalPart = 'm'.repeat(600);
    const p = await parseEmail(
      buildEml({
        headers: [
          'From: bot <bot@example.org>',
          'Subject: Digest',
          `Message-ID: <${longLocalPart}@example.org>`,
        ],
      }),
    );
    expect(p.messageId).toHaveLength(500);
    expect(p.dedupeKey).toBe(p.messageId);
  });

  it('clamps an oversized Date header to 200 characters', async () => {
    const longDate = `Fri, 3 Jul 2026 22:14:59 -0400 (${'x'.repeat(300)})`;
    const p = await parseEmail(
      buildEml({
        headers: ['From: bot <bot@example.org>', 'Subject: Digest', `Date: ${longDate}`],
      }),
    );
    expect(p.dateHeader).toHaveLength(200);
  });

  it('strips control characters out of the display name', async () => {
    const p = await parseEmail(
      buildEml({
        headers: [`From: "News${BEL}Bot" <bot@example.org>`, 'Subject: Digest'],
      }),
    );
    expect(p.fromName).toBe('NewsBot');
  });

  it('keeps the raw NUL byte in the html body instead of throwing', async () => {
    const p = await parseEmail(load('pathological.eml'));
    expect(p.html).toContain(NUL);
  });

  it('decodes the ISO-8859-1 8-bit part of the pathological fixture', async () => {
    const p = await parseEmail(load('pathological.eml'));
    expect(p.text).toContain('é');
  });
});

describe('parseEmail · authentication results', () => {
  it('reads the Authentication-Results header', async () => {
    const p = await parseEmail(load('substack.eml'));
    expect(p.authResults).toContain('dkim=pass');
    expect(p.authResults.length).toBeLessThanOrEqual(2000);
  });

  it('truncates an oversized Authentication-Results header to 2000 characters', async () => {
    const p = await parseEmail(
      buildEml({
        headers: [
          'From: bot <bot@example.org>',
          'Subject: Digest',
          `Authentication-Results: mx.example.org; ${'x'.repeat(3000)}`,
        ],
      }),
    );
    expect(p.authResults).toHaveLength(2000);
  });

  it('is null when the header is absent', async () => {
    const p = await parseEmail(buildEml({ headers: ['From: bot <bot@example.org>', 'Subject: Digest'] }));
    expect(p.authResults).toBeNull();
  });
});

describe('parseEmail · dedupe key', () => {
  it('uses the documented sha256 composition for the fallback key', async () => {
    const p = await parseEmail(load('pathological.eml'));
    const inner = sha256(`${p.html ?? ''}${p.text ?? ''}`);
    const expected = sha256(
      `${p.fromEmail ?? ''}\n${p.subject ?? ''}\n${p.dateHeader ?? ''}\n${inner}`,
    );
    expect(p.dedupeKey).toBe(expected);
  });

  // Regression pin, captured once the implementation was green. The dedupe key
  // is a storage contract: if it drifts, every already-ingested newsletter
  // re-ingests as new. pathological.eml is synthetic and is not part of the
  // Task 12 fixture swap, so this value is expected to stay put.
  it('pins the fallback key for the pathological fixture', async () => {
    const p = await parseEmail(load('pathological.eml'));
    expect(p.dedupeKey).toBe('dc40bf7aac00c0f0ba6872a371f6148bb975489b7e03387aa3c19ebc657bea56');
  });

  it('changes when only the Date header changes', async () => {
    const headers = (date) => [`Date: ${date}`, 'From: bot <bot@example.org>', 'Subject: Digest'];
    const a = await parseEmail(buildEml({ headers: headers('Fri, 3 Jul 2026 22:14:59 -0400') }));
    const b = await parseEmail(buildEml({ headers: headers('Sat, 4 Jul 2026 22:14:59 -0400') }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('exposes the raw Date header rather than a parsed timestamp', async () => {
    const p = await parseEmail(load('substack.eml'));
    expect(p.dateHeader).toBe('Wed, 29 Jul 2026 13:02:14 +0000');
  });
});

describe('parseEmail · unparseable input', () => {
  it('returns null for an empty buffer', async () => {
    expect(await parseEmail(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for a bare string with no headers or body structure', async () => {
    expect(await parseEmail(Buffer.from('not an email at all'))).toBeNull();
  });

  it('still parses a message that has headers but an empty body', async () => {
    const p = await parseEmail(buildEml({ headers: ['From: bot <bot@example.org>', 'Subject: Digest'], body: '' }));
    expect(p).not.toBeNull();
    expect(p.subject).toBe('Digest');
  });
});
