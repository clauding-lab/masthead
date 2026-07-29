import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/authVerify.js', () => {
  class AuthError extends Error {
    constructor(message) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireUser: vi.fn(), AuthError };
});
vi.mock('../lib/rateLimit.js', () => ({
  checkRateLimit: vi.fn(),
}));
vi.mock('../lib/urlGuard.js', () => ({
  assertPublicUrl: vi.fn(),
}));
vi.mock('../lib/premiumService.js', () => ({
  validateFeedUrl: vi.fn(),
  getPremiumArticleBody: vi.fn(),
}));
vi.mock('../lib/premiumRepo.js', () => {
  class PremiumCapError extends Error {}
  class PremiumDuplicateError extends Error {}
  return {
    listFeeds: vi.fn(),
    countFeeds: vi.fn(),
    findByUrl: vi.fn(),
    insertFeed: vi.fn(),
    updateFeedMeta: vi.fn(),
    deleteFeed: vi.fn(),
    PremiumCapError,
    PremiumDuplicateError,
  };
});

import { requireUser, AuthError } from '../lib/authVerify.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { assertPublicUrl } from '../lib/urlGuard.js';
import { validateFeedUrl, getPremiumArticleBody } from '../lib/premiumService.js';
import {
  listFeeds, countFeeds, findByUrl, insertFeed, updateFeedMeta, deleteFeed,
  PremiumCapError, PremiumDuplicateError,
} from '../lib/premiumRepo.js';
import handler from './premium-feeds.mjs';

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}

const USER_ID = 'user-1';
const GOOD_ROW = {
  id: 'feed-1', label: 'Feed Title', kind: 'news', category: 'custom',
  hostHint: 'good.example.com', createdAt: '2026-01-01T00:00:00.000Z',
};

function req(method, { body, query = '' } = {}) {
  return {
    method,
    url: `/api/premium-feeds${query}`,
    headers: { host: 'test', 'x-forwarded-for': '10.1.1.1', authorization: 'Bearer good-token' },
    body,
  };
}

// Rate-limit keys denied for the current test — everything else resolves
// allowed so the existing tests don't have to know about this mechanism.
let deniedRateLimitKeys;

beforeEach(() => {
  deniedRateLimitKeys = new Set();
  vi.mocked(requireUser).mockReset().mockResolvedValue({ userId: USER_ID });
  vi.mocked(checkRateLimit).mockReset().mockImplementation(async (key) => ({
    allowed: !deniedRateLimitKeys.has(key),
  }));
  vi.mocked(assertPublicUrl).mockReset().mockResolvedValue(undefined);
  vi.mocked(validateFeedUrl).mockReset().mockResolvedValue({ title: 'Feed Title', finalUrl: 'https://good.example.com/feed.xml' });
  vi.mocked(getPremiumArticleBody).mockReset();
  vi.mocked(listFeeds).mockReset().mockResolvedValue([]);
  vi.mocked(countFeeds).mockReset().mockResolvedValue(0);
  vi.mocked(findByUrl).mockReset().mockResolvedValue(null);
  vi.mocked(insertFeed).mockReset().mockResolvedValue(GOOD_ROW);
  vi.mocked(updateFeedMeta).mockReset();
  vi.mocked(deleteFeed).mockReset();
});

describe('auth guard (spec §4.1)', () => {
  it.each(['GET', 'POST', 'PATCH', 'DELETE'])('%s → 401 when requireUser throws AuthError', async (method) => {
    vi.mocked(requireUser).mockRejectedValue(new AuthError('no token'));
    const res = fakeRes();
    await handler(req(method, { body: { url: 'https://x.example/f', kind: 'news' } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('a non-AuthError from requireUser → 500 without leaking any url in the response', async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error('boom against https://secret-leak.example.com/token'));
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret-leak.example.com');
  });
});

describe('rate limiting (spec §4.1)', () => {
  it('per-IP limiter (premium:${ip}) denies → 429 before requireUser is ever called', async () => {
    deniedRateLimitKeys.add('premium:10.1.1.1');
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
    expect(requireUser).not.toHaveBeenCalled();
  });

  it('POST per-user add limiter (premium-add:${userId}) denies with IP limiter allowing → 429 before any network/validation call', async () => {
    deniedRateLimitKeys.add(`premium-add:${USER_ID}`);
    const res = fakeRes();
    await handler(req('POST', { body: { url: 'https://good.example.com/feed.xml', kind: 'news' } }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
    expect(assertPublicUrl).not.toHaveBeenCalled();
    expect(validateFeedUrl).not.toHaveBeenCalled();
    expect(insertFeed).not.toHaveBeenCalled();
  });

  it('body GET per-user limiter (premium-body:${userId}) denies with IP limiter allowing → 429 before getPremiumArticleBody runs', async () => {
    deniedRateLimitKeys.add(`premium-body:${USER_ID}`);
    const res = fakeRes();
    await handler(req('GET', { query: '?feed=feed-1&article=known' }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
    expect(getPremiumArticleBody).not.toHaveBeenCalled();
  });
});

describe('POST /api/premium-feeds', () => {
  const SECRET_URL = 'https://good.example.com/premium/secrettoken123abc/feed.xml';

  it('happy path → 201 with hostHint and no url key in the response', async () => {
    const res = fakeRes();
    await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('hostHint');
    expect('url' in res.body).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_URL);
    expect(JSON.stringify(res.body)).not.toContain('secrettoken123abc');
  });

  it('http:// url → 400 https required', async () => {
    const res = fakeRes();
    await handler(req('POST', { body: { url: 'http://insecure.example.com/feed.xml', kind: 'news' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'https required' });
    expect(countFeeds).not.toHaveBeenCalled();
    expect(validateFeedUrl).not.toHaveBeenCalled();
  });

  it('cap reached via early countFeeds check → 403', async () => {
    vi.mocked(countFeeds).mockResolvedValue(5);
    const res = fakeRes();
    await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Premium feed limit reached (5)' });
  });

  it('cap reached via race-condition PremiumCapError from insertFeed → 403', async () => {
    vi.mocked(countFeeds).mockResolvedValue(4);
    vi.mocked(insertFeed).mockRejectedValue(new PremiumCapError('cap reached'));
    const res = fakeRes();
    await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Premium feed limit reached (5)' });
  });

  it('duplicate via early findByUrl hit → 409', async () => {
    vi.mocked(findByUrl).mockResolvedValue({ id: 'existing' });
    const res = fakeRes();
    await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Already added' });
    expect(validateFeedUrl).not.toHaveBeenCalled();
  });

  it('duplicate via race-condition PremiumDuplicateError from insertFeed → 409', async () => {
    vi.mocked(insertFeed).mockRejectedValue(new PremiumDuplicateError('duplicate url'));
    const res = fakeRes();
    await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Already added' });
  });

  describe('anti-oracle: validateFeedUrl failures collapse to one generic 422', () => {
    const causes = [
      ['a guard-style rejection', new Error('Address not allowed')],
      ['a network timeout', new Error('premium timeout')],
      ['a parser failure', new TypeError('Cannot read properties of undefined')],
    ];
    it.each(causes)('%s → byte-identical 422', async (_label, err) => {
      vi.mocked(validateFeedUrl).mockRejectedValue(err);
      const res = fakeRes();
      await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({ error: 'Could not validate feed URL' });
    });

    it('all three causes produce byte-identical response bodies', async () => {
      const bodies = [];
      for (const [, err] of causes) {
        vi.mocked(validateFeedUrl).mockReset().mockRejectedValue(err);
        const res = fakeRes();
        await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
        bodies.push(JSON.stringify(res.body));
      }
      expect(new Set(bodies).size).toBe(1);
    });

    // Important 3 (final review): a validation failure must not vanish
    // silently — but the log line is host-only, never the full url or token.
    it('logs the registrable domain on a validate failure, never the full url/token, while the 422 body stays byte-identical', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(validateFeedUrl).mockRejectedValue(new Error('Address not allowed'));
      const res = fakeRes();

      await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);

      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({ error: 'Could not validate feed URL' });

      const call = consoleSpy.mock.calls.find(([prefix]) => prefix === '[premium-feeds] validate failed:');
      expect(call).toBeTruthy();
      const [, loggedHost] = call;
      expect(typeof loggedHost).toBe('string');
      expect(loggedHost).toContain('example.com');
      expect(loggedHost).not.toContain(SECRET_URL);
      expect(loggedHost).not.toContain('secrettoken123abc');

      consoleSpy.mockRestore();
    });

    it('a malformed url that still passes the https:// check falls back to a static host string instead of throwing out of the handler', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(validateFeedUrl).mockRejectedValue(new Error('parse failure'));
      const res = fakeRes();

      await handler(req('POST', { body: { url: 'https://', kind: 'news' } }), res);

      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({ error: 'Could not validate feed URL' });
      const call = consoleSpy.mock.calls.find(([prefix]) => prefix === '[premium-feeds] validate failed:');
      expect(call).toEqual(['[premium-feeds] validate failed:', 'unparseable-host']);

      consoleSpy.mockRestore();
    });
  });

  it('cheap-before-network order: countFeeds=5 blocks validateFeedUrl from ever running', async () => {
    vi.mocked(countFeeds).mockResolvedValue(5);
    const res = fakeRes();
    await handler(req('POST', { body: { url: SECRET_URL, kind: 'news' } }), res);
    expect(validateFeedUrl).not.toHaveBeenCalled();
    expect(assertPublicUrl).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('GET body-on-demand (spec §4.1)', () => {
  it('unknown article → 404 with generic body', async () => {
    vi.mocked(getPremiumArticleBody).mockResolvedValue(null);
    const res = fakeRes();
    await handler(req('GET', { query: '?feed=feed-1&article=missing' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('owned feed + known article → 200 with content', async () => {
    const article = { title: 'T', url: 'https://x.example/a', content: '<p>Body</p>' };
    vi.mocked(getPremiumArticleBody).mockResolvedValue(article);
    const res = fakeRes();
    await handler(req('GET', { query: '?feed=feed-1&article=known' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ article });
  });

  it('no feed/article params → falls back to listFeeds', async () => {
    const res = fakeRes();
    await handler(req('GET'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ feeds: [] });
    expect(listFeeds).toHaveBeenCalledWith(USER_ID);
  });
});

describe('PATCH/DELETE foreign-id handling', () => {
  it('PATCH a foreign id (repo returns null) → 404', async () => {
    vi.mocked(updateFeedMeta).mockResolvedValue(null);
    const res = fakeRes();
    await handler(req('PATCH', { body: { id: 'foreign-id', label: 'New label' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('DELETE a foreign id (repo returns false) → 404', async () => {
    vi.mocked(deleteFeed).mockResolvedValue(false);
    const res = fakeRes();
    await handler(req('DELETE', { body: { id: 'foreign-id' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});
