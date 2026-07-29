// lib/premiumRedact.test.js
import { describe, it, expect } from 'vitest';
import { secretParts, redactString, redactContentHtml } from './premiumRedact.js';

const FEED = 'https://example.com/premium/a1b2c3d4e5f6g7h8i9j0/feed.xml?key=s3cr3tk3y99&size=10';

describe('secretParts (spec §4.3 rule 1)', () => {
  it('captures long query values and high-entropy path segments, skips short/common ones', () => {
    const parts = secretParts(FEED);
    expect(parts).toContain('s3cr3tk3y99');          // query value >= 8 chars
    expect(parts).toContain('a1b2c3d4e5f6g7h8i9j0'); // path segment >= 16 chars
    expect(parts).not.toContain('10');               // short query value
    expect(parts).not.toContain('premium');          // short path segment
    expect(parts).not.toContain('feed.xml');         // contains '.', not token-shaped
  });
  it('returns [] for a secret-free URL', () => {
    expect(secretParts('https://example.com/rss/index.xml')).toEqual([]);
  });
});

describe('redactString', () => {
  it('strips every secret part from item links', () => {
    const parts = secretParts(FEED);
    const link = 'https://example.com/article/42?key=s3cr3tk3y99&utm=x';
    const out = redactString(link, parts);
    expect(out).not.toContain('s3cr3tk3y99');
    expect(out).toContain('/article/42');
  });
  it('is a no-op with no parts', () => {
    expect(redactString('https://a.com/b', [])).toBe('https://a.com/b');
  });
});

describe('redactContentHtml', () => {
  it('drops hrefs that carry the token but keeps the anchor text', () => {
    const parts = secretParts(FEED);
    const html = '<p>Body</p><a href="https://example.com/manage?key=s3cr3tk3y99">Manage subscription</a>';
    const out = redactContentHtml(html, parts);
    expect(out).not.toContain('s3cr3tk3y99');
    expect(out).toContain('Manage subscription');
  });
  it('redacts bare token occurrences in text', () => {
    const parts = secretParts(FEED);
    expect(redactContentHtml('token is s3cr3tk3y99 here', parts)).not.toContain('s3cr3tk3y99');
  });
});
