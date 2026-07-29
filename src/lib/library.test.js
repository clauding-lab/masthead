// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import {
  saveArticle, retrySave, deleteSaved, attachBodyToSaved, processPendingSaves,
  resolveReaderSource, firstHttpUrl, capContent, LibrarySaveError,
} from './library.js';
import { getFavorite, getAllFavorites, saveFavorite, addPendingUrl, getPendingUrls } from './db.js';
import { articleId } from '../../lib/articleId.js';

vi.mock('./premiumApi', () => ({
  fetchPremiumBody: vi.fn(),
}));
import { fetchPremiumBody } from './premiumApi';

const BODY = { title: 'Full', byline: 'By A', excerpt: 'ex', content: '<p>body</p>', leadImage: null, wordCount: 9, readingTimeMinutes: 1 };
const noQueueWait = { spacingMs: 0, backoffMs: 0 };
const deps = (over = {}) => ({
  extract: vi.fn().mockResolvedValue(BODY),
  pushSavedFn: vi.fn().mockResolvedValue(undefined),
  removeSavedFn: vi.fn().mockResolvedValue(undefined),
  getUser: () => ({ id: 'u1' }),
  ...noQueueWait,
  ...over,
});

describe('helpers', () => {
  it('firstHttpUrl finds the first link in shared text, null otherwise', () => {
    expect(firstHttpUrl('look at https://x.example/a and more')).toBe('https://x.example/a');
    expect(firstHttpUrl('no links here')).toBeNull();
    expect(firstHttpUrl(null)).toBeNull();
  });
  it('capContent truncates beyond 1.5M chars and flags it', () => {
    const big = 'x'.repeat(1_500_001);
    const capped = capContent(big);
    expect(capped.content).toHaveLength(1_500_000);
    expect(capped.contentTruncated).toBe(true);
    expect(capContent('small')).toEqual({ content: 'small', contentTruncated: false });
  });
  it('resolveReaderSource: stored for body, live for shell-with-url, shell without url, none otherwise', () => {
    expect(resolveReaderSource({ content: '<p>x</p>' }, null)).toBe('stored');
    expect(resolveReaderSource({ textContent: 'x' }, null)).toBe('stored');
    expect(resolveReaderSource({ content: null }, 'https://x.example/a')).toBe('live');
    expect(resolveReaderSource({ content: null, url: '' }, null)).toBe('shell');
    expect(resolveReaderSource(undefined, null)).toBe('none');
  });
  it('resolveReaderSource: a premium bodyFailed shell never resolves to "live" (2E fix wave 1)', () => {
    expect(resolveReaderSource({ content: null, savedVia: 'premium', sourceId: 'feedA' }, 'https://pub.example/x')).toBe('premium');
    expect(resolveReaderSource({ content: null, savedVia: 'premium', sourceId: null }, 'https://pub.example/x')).toBe('shell');
    expect(resolveReaderSource({ content: '<p>x</p>', savedVia: 'premium', sourceId: 'feedA' }, 'https://pub.example/x')).toBe('stored');
  });
});

describe('saveArticle', () => {
  it('paste happy path: files intent, extracts, attaches body, pushes to cloud, sets discriminator', async () => {
    const d = deps();
    const record = await saveArticle({ url: 'https://x.example/story', savedVia: 'url' }, d);
    expect(record.id).toBe(articleId('https://x.example/story'));
    expect(record.isFavorite).toBe(true);
    expect(record.savedVia).toBe('url');
    expect(record.content).toBe('<p>body</p>');
    expect(record.pendingBody).toBe(false);
    expect(d.pushSavedFn).toHaveBeenCalledWith('u1', expect.objectContaining({ content: '<p>body</p>' }));
  });
  it('prefers the caller-supplied headline id (link-less feed items stay heartable)', async () => {
    const d = deps();
    const record = await saveArticle({ url: '', id: 'feedid1234567890', sourceMeta: { title: 'Linkless' }, savedVia: 'feed' }, d);
    expect(record.id).toBe('feedid1234567890');
    expect(d.extract).not.toHaveBeenCalled();
    expect(record.bodyFailed).toBe(true);
  });
  it('rejects only when both id and url are absent', async () => {
    await expect(saveArticle({ url: 'not a url' }, deps())).rejects.toBeInstanceOf(LibrarySaveError);
  });
  it('extraction failure files a bodyFailed shell and still pushes a metadata-only record', async () => {
    const d = deps({ extract: vi.fn().mockRejectedValue(new Error('boom')) });
    const record = await saveArticle({ url: 'https://x.example/fail' }, d);
    expect(record.bodyFailed).toBe(true);
    expect(record.content).toBeUndefined();
    expect(d.pushSavedFn).toHaveBeenCalledWith('u1', expect.objectContaining({ bodyFailed: true }));
  });
  it('heart-from-reader reuses the preloaded body — extract is never called', async () => {
    const d = deps();
    const record = await saveArticle(
      { url: 'https://x.example/read', savedVia: 'feed', preloadedArticle: BODY },
      d
    );
    expect(d.extract).not.toHaveBeenCalled();
    expect(record.content).toBe('<p>body</p>');
  });
  it('retries once after a 429 then succeeds', async () => {
    const d = deps({
      extract: vi.fn()
        .mockRejectedValueOnce(new Error('Extraction failed: 429'))
        .mockResolvedValueOnce(BODY),
    });
    const record = await saveArticle({ url: 'https://x.example/limited' }, d);
    expect(d.extract).toHaveBeenCalledTimes(2);
    expect(record.content).toBe('<p>body</p>');
  });
  it('logged-out: saves locally, never touches cloud', async () => {
    const d = deps({ getUser: () => null });
    await saveArticle({ url: 'https://x.example/anon' }, d);
    expect(d.pushSavedFn).not.toHaveBeenCalled();
    expect((await getFavorite(articleId('https://x.example/anon'))).content).toBe('<p>body</p>');
  });
  it('dedup: heart then paste of the same URL is one record', async () => {
    const d = deps();
    const url = 'https://x.example/same';
    await saveArticle({ url, id: articleId(url), savedVia: 'feed' }, d);
    await saveArticle({ url, savedVia: 'url' }, d);
    const all = await getAllFavorites();
    expect(all.filter((a) => a.url === url)).toHaveLength(1);
  });
});

describe('saveArticle: premium body (2E)', () => {
  it('never calls the extractor and stores the premium content fetched via fetchPremiumBody', async () => {
    fetchPremiumBody.mockReset().mockResolvedValue({ title: 'P', url: 'https://pub.example/p', content: '<p>premium body</p>' });
    const d = deps();
    const record = await saveArticle(
      { url: 'https://pub.example/p', id: 'premid1234567890', sourceMeta: { sourceId: 'feedA', title: 'Premium Co' }, savedVia: 'premium' },
      d
    );
    expect(d.extract).not.toHaveBeenCalled();
    expect(fetchPremiumBody).toHaveBeenCalledWith('feedA', 'premid1234567890');
    expect(record.content).toBe('<p>premium body</p>');
    expect(record.pendingBody).toBe(false);
    expect(record.bodyFailed).toBe(false);
    expect(d.pushSavedFn).toHaveBeenCalledWith('u1', expect.objectContaining({ content: '<p>premium body</p>' }));
  });

  it('a failed premium body fetch files a bodyFailed shell and never calls the extractor', async () => {
    fetchPremiumBody.mockReset().mockRejectedValue(new Error('Sign in required'));
    const d = deps();
    const record = await saveArticle(
      { url: 'https://pub.example/q', id: 'premid2234567890', sourceMeta: { sourceId: 'feedA' }, savedVia: 'premium' },
      d
    );
    expect(d.extract).not.toHaveBeenCalled();
    expect(record.bodyFailed).toBe(true);
    expect(record.content).toBeUndefined();
  });
});

describe('retrySave / attachBodyToSaved / deleteSaved / processPendingSaves', () => {
  it('retrySave re-extracts a failed shell and attaches the body', async () => {
    const failing = deps({ extract: vi.fn().mockRejectedValue(new Error('down')) });
    const shell = await saveArticle({ url: 'https://x.example/retry' }, failing);
    expect(shell.bodyFailed).toBe(true);
    const ok = deps();
    const record = await retrySave(shell.id, ok);
    expect(record.content).toBe('<p>body</p>');
    expect(record.bodyFailed).toBe(false);
  });
  it('attachBodyToSaved patches a shell with a live-fetched article and pushes it', async () => {
    await saveFavorite({ id: 'shellid123456789', url: 'https://x.example/att', title: 'S', pendingBody: false, bodyFailed: true });
    const d = deps();
    const record = await attachBodyToSaved('shellid123456789', BODY, d);
    expect(record.content).toBe('<p>body</p>');
    expect(d.pushSavedFn).toHaveBeenCalled();
  });
  it('deleteSaved removes locally and tombstones cloud for signed-in users', async () => {
    const d = deps();
    const saved = await saveArticle({ url: 'https://x.example/gone' }, d);
    await deleteSaved({ id: saved.id, url: saved.url }, d);
    expect(await getFavorite(saved.id)).toBeUndefined();
    expect(d.removeSavedFn).toHaveBeenCalledWith('u1', { id: saved.id, url: saved.url });
  });
  it('processPendingSaves drains the pending store through saveArticle', async () => {
    await addPendingUrl('https://x.example/pending1');
    const d = deps();
    const n = await processPendingSaves(d);
    expect(n).toBe(1);
    expect(await getPendingUrls()).toHaveLength(0);
    expect(await getFavorite(articleId('https://x.example/pending1'))).toBeDefined();
  });
});

describe('retrySave / attachBodyToSaved: premium records (2E fix wave 1)', () => {
  it('retrySave on a premium record retries via fetchPremiumBody and never calls the extractor', async () => {
    await saveFavorite({
      id: 'premretry1234567', url: 'https://pub.example/y', title: 'P',
      sourceId: 'feedA', savedVia: 'premium', pendingBody: false, bodyFailed: true,
    });
    fetchPremiumBody.mockReset().mockResolvedValue({ title: 'P2', url: 'https://pub.example/y', content: '<p>real premium body</p>' });
    const d = deps();
    const record = await retrySave('premretry1234567', d);
    expect(d.extract).not.toHaveBeenCalled();
    expect(fetchPremiumBody).toHaveBeenCalledWith('feedA', 'premretry1234567');
    expect(record.content).toBe('<p>real premium body</p>');
    expect(record.bodyFailed).toBe(false);
  });

  it('a failed premium retry keeps the bodyFailed shell and never calls the extractor', async () => {
    await saveFavorite({
      id: 'premretry2234567', url: 'https://pub.example/z', title: 'P',
      sourceId: 'feedA', savedVia: 'premium', pendingBody: false, bodyFailed: true,
    });
    fetchPremiumBody.mockReset().mockRejectedValue(new Error('Sign in required'));
    const d = deps();
    const record = await retrySave('premretry2234567', d);
    expect(d.extract).not.toHaveBeenCalled();
    expect(record.bodyFailed).toBe(true);
    expect(record.content).toBeUndefined();
  });

  it('attachBodyToSaved refuses to write extractor-sourced content into a premium record', async () => {
    await saveFavorite({
      id: 'premshell1234567', url: 'https://pub.example/x', title: 'P',
      sourceId: 'feedA', savedVia: 'premium', pendingBody: false, bodyFailed: true,
    });
    const d = deps();
    const extractorLikeBody = { ...BODY, extractedAt: new Date().toISOString() };
    const record = await attachBodyToSaved('premshell1234567', extractorLikeBody, d);
    expect(record.content).toBeUndefined();
    expect(d.pushSavedFn).not.toHaveBeenCalled();
  });
});
