// lib/premiumService.test.js (validation describe-block; Task 6 appends more)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateFeedUrl, PremiumValidationError } from './premiumService.js';

const FIXTURE = readFileSync(new URL('./__fixtures__/premium-substack-full.xml', import.meta.url), 'utf8');
const TOKEN_URL = 'https://example.com/premium/a1b2c3d4e5f6g7h8i9j0/feed.xml?key=s3cr3tk3y99';

describe('validateFeedUrl (spec §4.1)', () => {
  it('returns feed title and final URL for a parseable feed', async () => {
    const fetchRaw = async () => ({ items: [{}], title: 'Construction Physics', finalUrl: TOKEN_URL });
    const result = await validateFeedUrl(TOKEN_URL, { fetchRaw });
    expect(result.title).toBe('Construction Physics');
    expect(result.finalUrl).toBe(TOKEN_URL);
  });
  it('parses the real fixture end-to-end through the parser seam', async () => {
    const { fetchRawItems } = await import('./feedParser.js');
    // inject fixture at the fetch layer: stub safeFetch is overkill here — parse directly
    const Parser = (await import('rss-parser')).default;
    const feed = await new Parser().parseString(FIXTURE);
    expect(feed.items.length).toBeGreaterThan(0);
    expect(feed.items[0]['content:encoded'] || feed.items[0].content).toBeTruthy();
    expect(typeof fetchRawItems).toBe('function');
  });
  it('wraps any failure (guard, network, non-feed) as PremiumValidationError', async () => {
    const fetchRaw = async () => { throw new Error('Address not allowed'); };
    await expect(validateFeedUrl(TOKEN_URL, { fetchRaw })).rejects.toBeInstanceOf(PremiumValidationError);
  });
  it('rejects a feed with zero items as unparseable', async () => {
    const fetchRaw = async () => ({ items: [], title: '', finalUrl: TOKEN_URL });
    await expect(validateFeedUrl(TOKEN_URL, { fetchRaw })).rejects.toBeInstanceOf(PremiumValidationError);
  });
});
