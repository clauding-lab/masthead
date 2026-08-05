// Security review fix round 1, F1 (HIGH): extractArticle is the SINGLE
// funnel every "fetch the article body" caller shares — library.js's
// extractQueued (saveArticle/retrySave) AND articleStore#fetchArticle
// (reached unguarded from ReaderPage's History-shaped entry point, which
// carries no fromFavorites and so never passes through
// resolveReaderSource's inbox guard). A minted inbox permalink must never
// reach POST /api/extract, which would fetch the app's own SPA shell.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractArticle } from './api';

const PERMALINK = 'https://masthead.example/inbox/message/a1b2c3d4-1111-4111-8111-000000000001';

function mockFetchOnce(status, body) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = fn;
  return fn;
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

describe('extractArticle — inbox permalink funnel guard', () => {
  it('refuses an inbox permalink before any HTTP call — the fetch layer is never touched', async () => {
    await expect(extractArticle(PERMALINK, null)).rejects.toThrow('Inbox messages are not extractable');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a normal article URL is unaffected — the guard is url-shape-specific, not blanket', async () => {
    const fetchSpy = mockFetchOnce(200, { title: 'T', content: '<p>x</p>' });

    const result = await extractArticle('https://news.example/story', 'src1');

    expect(fetchSpy).toHaveBeenCalledWith('/api/extract', expect.objectContaining({ method: 'POST' }));
    expect(result).toEqual({ title: 'T', content: '<p>x</p>' });
  });
});

describe('extractArticle — existing behavior (regression guard)', () => {
  it('throws with the server error message on a non-ok response', async () => {
    mockFetchOnce(500, { message: 'boom' });

    await expect(extractArticle('https://news.example/fail')).rejects.toThrow('boom');
  });
});
