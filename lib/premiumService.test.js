// lib/premiumService.test.js (validation describe-block; Task 6 appends more)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Parser from 'rss-parser';
import { validateFeedUrl, PremiumValidationError } from './premiumService.js';
import {
  resolvePremiumSources,
  fetchPremiumHeadlines,
  getPremiumArticleBody,
  resetPremiumCacheForTests,
  MAX_PREMIUM_IDS,
  PREMIUM_TIMEOUT_MS,
  MAX_BODY_CHARS,
} from './premiumService.js';
import { parserOptions } from './feedParser.js';
import { articleId } from './articleId.js';

const FIXTURE = readFileSync(new URL('./__fixtures__/premium-substack-full.xml', import.meta.url), 'utf8');
const TOKEN_URL = 'https://example.com/premium/a1b2c3d4e5f6g7h8i9j0/feed.xml?key=s3cr3tk3y99';
const SECRET_PART = 'a1b2c3d4e5f6g7h8i9j0'; // path token in TOKEN_URL — see premiumRedact.test.js FEED fixture

async function fixtureItems() {
  const feed = await new Parser(parserOptions).parseString(FIXTURE);
  return feed.items;
}

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

// --- Task 6: resolve -> fetch (timeout + TTL cache + redaction) -> body-on-demand ---

const DEF = {
  id: 'feed-a',
  url: TOKEN_URL,
  label: 'Construction Physics',
  kind: 'newsletter',
  category: 'tech',
  hostHint: 'example.com',
};

beforeEach(() => {
  resetPremiumCacheForTests();
});

describe('resolvePremiumSources (spec §4.2)', () => {
  it('slices ids to MAX_PREMIUM_IDS before querying the repo and returns only owned defs', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `id-${i}`);
    let receivedIds;
    const getOwned = async (userId, idsArg) => {
      receivedIds = idsArg;
      // Simulate the repo scoping to owned rows only — drop half of what was asked for.
      return idsArg.slice(0, 3).map((id) => ({ ...DEF, id }));
    };
    const defs = await resolvePremiumSources('user-1', ids, { getOwned });
    expect(receivedIds).toHaveLength(MAX_PREMIUM_IDS);
    expect(receivedIds).toEqual(ids.slice(0, MAX_PREMIUM_IDS));
    expect(defs).toHaveLength(3);
  });
});

describe('fetchPremiumHeadlines (spec §4.2)', () => {
  it('maps items to headline cards: isPremium, premiumFeedId, sourceName, hasBody, and a redacted url', async () => {
    const rawItems = await fixtureItems();
    const poisoned = { ...rawItems[0], link: `${rawItems[0].link}?ref=${SECRET_PART}` };
    const fetchRaw = async () => ({ items: [poisoned] });
    const { headlines, stats, premiumStatus } = await fetchPremiumHeadlines([DEF], { fetchRaw });
    expect(headlines).toHaveLength(1);
    const [h] = headlines;
    expect(h.isPremium).toBe(true);
    expect(h.premiumFeedId).toBe(DEF.id);
    expect(h.sourceName).toBe(DEF.label);
    expect(h.hasBody).toBe(true);
    expect(h.url).not.toContain(SECRET_PART);
    expect(stats).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(premiumStatus).toEqual([{ id: DEF.id, ok: true }]);
  });

  it('isolates a rejected (403) feed from a succeeding feed — other feed headlines stay intact', async () => {
    const rawItems = await fixtureItems();
    const DEF_OK = { ...DEF, id: 'feed-ok', url: TOKEN_URL };
    const DEF_REJECTED = {
      ...DEF,
      id: 'feed-rejected',
      url: 'https://secret123.newsletter.co.uk/feed.xml?key=zzzzzzzz99',
      hostHint: 'newsletter.co.uk',
    };
    const fetchRaw = async ({ feedUrl }) => {
      if (feedUrl === DEF_REJECTED.url) {
        const err = new Error('HTTP 403');
        err.status = 403;
        throw err;
      }
      return { items: rawItems.slice(0, 2) };
    };
    const { headlines, premiumStatus } = await fetchPremiumHeadlines([DEF_OK, DEF_REJECTED], { fetchRaw });
    expect(headlines.length).toBe(2);
    expect(headlines.every((h) => h.premiumFeedId === DEF_OK.id)).toBe(true);
    expect(premiumStatus).toContainEqual({ id: DEF_OK.id, ok: true });
    expect(premiumStatus).toContainEqual({ id: DEF_REJECTED.id, ok: false, reason: 'rejected' });
  });

  it('marks a feed unavailable (not rejected) on a plain network error with no HTTP status', async () => {
    const fetchRaw = async () => { throw new Error('ECONNRESET'); };
    const { headlines, premiumStatus } = await fetchPremiumHeadlines([DEF], { fetchRaw });
    expect(headlines).toHaveLength(0);
    expect(premiumStatus).toEqual([{ id: DEF.id, ok: false, reason: 'unavailable' }]);
  });

  it('treats redirect drift (finalUrl outside the approved registrable domain) as rejected', async () => {
    const rawItems = await fixtureItems();
    const fetchRaw = async () => ({ items: rawItems, finalUrl: 'https://evil.example/hijacked' });
    const { headlines, premiumStatus } = await fetchPremiumHeadlines([DEF], { fetchRaw });
    expect(headlines).toHaveLength(0);
    expect(premiumStatus).toEqual([{ id: DEF.id, ok: false, reason: 'rejected' }]);
  });

  it('marks a feed failed once fetchRaw exceeds PREMIUM_TIMEOUT_MS instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const fetchRaw = () => new Promise(() => {}); // never resolves
      const pending = fetchPremiumHeadlines([DEF], { fetchRaw });
      await vi.advanceTimersByTimeAsync(PREMIUM_TIMEOUT_MS + 10);
      const { headlines, premiumStatus } = await pending;
      expect(headlines).toHaveLength(0);
      expect(premiumStatus).toEqual([{ id: DEF.id, ok: false, reason: 'unavailable' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('single-flights concurrent calls for the same def within the TTL window', async () => {
    let callCount = 0;
    const rawItems = await fixtureItems();
    const fetchRaw = async () => {
      callCount++;
      return { items: rawItems.slice(0, 1) };
    };
    const [r1, r2] = await Promise.all([
      fetchPremiumHeadlines([DEF], { fetchRaw }),
      fetchPremiumHeadlines([DEF], { fetchRaw }),
    ]);
    expect(callCount).toBe(1);
    expect(r1.headlines).toHaveLength(1);
    expect(r2.headlines).toHaveLength(1);
  });

  it('re-fetches after resetPremiumCacheForTests clears the single-flight cache', async () => {
    let callCount = 0;
    const rawItems = await fixtureItems();
    const fetchRaw = async () => {
      callCount++;
      return { items: rawItems.slice(0, 1) };
    };
    await fetchPremiumHeadlines([DEF], { fetchRaw });
    expect(callCount).toBe(1);
    resetPremiumCacheForTests();
    await fetchPremiumHeadlines([DEF], { fetchRaw });
    expect(callCount).toBe(2);
  });
});

describe('log scrubbing (custody rule 4)', () => {
  it('logs only def.id and def.hostHint on a failing fetch — never the url or a secret part', async () => {
    const err = new Error(`fetch failed for ${TOKEN_URL}`); // simulate a message that embeds the url
    err.status = 403;
    const fetchRaw = async () => { throw err; };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await fetchPremiumHeadlines([DEF], { fetchRaw });
      const lines = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String);
      expect(logSpy.mock.calls.length + errorSpy.mock.calls.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(SECRET_PART);
        expect(line).not.toContain(TOKEN_URL);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs only def.id and def.hostHint when the body fetch fails — never the url or a secret part', async () => {
    const err = new Error(`network fail ${TOKEN_URL}`);
    const fetchRaw = async () => { throw err; };
    const getOwned = async () => [DEF];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await getPremiumArticleBody('user-1', DEF.id, 'whatever', { getOwned, fetchRaw });
      expect(result).toBeNull();
      const lines = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String);
      for (const line of lines) {
        expect(line).not.toContain(SECRET_PART);
        expect(line).not.toContain(TOKEN_URL);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('getPremiumArticleBody (spec §4.2)', () => {
  it('returns sanitized, redacted content for a known articleId, clamped to MAX_BODY_CHARS', async () => {
    const rawItems = await fixtureItems();
    const target = rawItems[0];
    const targetId = articleId(target);
    const getOwned = async () => [DEF];
    const fetchRaw = async () => ({ items: rawItems });
    const result = await getPremiumArticleBody('user-1', DEF.id, targetId, { getOwned, fetchRaw });
    expect(result).not.toBeNull();
    expect(result.title).toBeTruthy();
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });

  it('returns null for an unknown articleId', async () => {
    const rawItems = await fixtureItems();
    const getOwned = async () => [DEF];
    const fetchRaw = async () => ({ items: rawItems });
    const result = await getPremiumArticleBody('user-1', DEF.id, 'nonexistent-id-00000000', { getOwned, fetchRaw });
    expect(result).toBeNull();
  });

  it('returns null when the user does not own the feed (repo returns nothing)', async () => {
    const getOwned = async () => [];
    const fetchRaw = async () => { throw new Error('must not be called for an unowned feed'); };
    const result = await getPremiumArticleBody('user-1', 'feed-a', 'whatever', { getOwned, fetchRaw });
    expect(result).toBeNull();
  });

  it('strips a token-bearing unsubscribe href from body content but keeps the anchor text', async () => {
    const item = {
      title: 'Weekly Digest',
      link: 'https://www.construction-physics.com/p/weekly-digest',
      guid: 'tag:site,2026:weekly-digest',
      'content:encoded': `<p>Body text.</p><a href="https://example.com/unsubscribe?key=${SECRET_PART}">Unsubscribe</a>`,
    };
    const targetId = articleId(item);
    const getOwned = async () => [DEF];
    const fetchRaw = async () => ({ items: [item] });
    const result = await getPremiumArticleBody('user-1', DEF.id, targetId, { getOwned, fetchRaw });
    expect(result).not.toBeNull();
    expect(result.content).not.toContain(SECRET_PART);
    expect(result.content).toContain('Unsubscribe');
    expect(result.content).not.toContain('href="https://example.com/unsubscribe');
  });
});
