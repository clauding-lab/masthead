import { articleId } from '../../lib/articleId.js';
import { extractArticle as apiExtract } from './api';
import {
  saveFavorite, removeFavorite, getFavorite, patchSavedArticle,
  getPendingUrls, removePendingUrl,
} from './db';
import { pushSaved, removeSaved } from './sync';
import useAuthStore from '../stores/authStore';

const MAX_CONTENT_CHARS = 1_500_000;
const QUEUE_SPACING_MS = 3000;
const RATE_LIMIT_BACKOFF_MS = 15000;

export class LibrarySaveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LibrarySaveError';
  }
}

export function firstHttpUrl(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : null;
}

export function capContent(content) {
  if (typeof content !== 'string') return { content: null, contentTruncated: false };
  if (content.length <= MAX_CONTENT_CHARS) return { content, contentTruncated: false };
  return { content: content.slice(0, MAX_CONTENT_CHARS), contentTruncated: true };
}

// The reader's saved-item branch keys on CONTENT-presence, not record-presence
// (spec §4 reader integration): shells must never dead-end.
export function resolveReaderSource(saved, url) {
  if (saved && (saved.content || saved.textContent)) return 'stored';
  if (url) return 'live';
  if (saved) return 'shell';
  return 'none';
}

function defaultDeps(deps) {
  return {
    extract: apiExtract,
    pushSavedFn: pushSaved,
    removeSavedFn: removeSaved,
    getUser: () => useAuthStore.getState().user,
    spacingMs: QUEUE_SPACING_MS,
    backoffMs: RATE_LIMIT_BACKOFF_MS,
    ...deps,
  };
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Sequential, paced extraction queue. Pacing bounds request rate (concurrency
// alone does not); one backoff retry on 429, then the caller files a
// bodyFailed shell. Never throws.
let queueTail = Promise.resolve();
let lastRunAt = 0;
function extractQueued(url, sourceId, d) {
  const run = queueTail.then(async () => {
    await sleep(Math.max(0, lastRunAt + d.spacingMs - Date.now()));
    lastRunAt = Date.now();
    try {
      return await d.extract(url, sourceId);
    } catch (err) {
      if (String(err?.message).includes('429')) {
        await sleep(d.backoffMs);
        lastRunAt = Date.now();
        try {
          return await d.extract(url, sourceId);
        } catch {
          return null;
        }
      }
      return null;
    }
  });
  queueTail = run.catch(() => {});
  return run;
}

async function applyBody(id, body, shellTitle) {
  const { content, contentTruncated } = capContent(body.content);
  return patchSavedArticle(id, {
    title: body.title || shellTitle,
    byline: body.byline ?? null,
    excerpt: body.excerpt ?? '',
    content,
    contentTruncated,
    textContent: body.textContent ?? null,
    leadImage: body.leadImage ?? null,
    wordCount: body.wordCount ?? null,
    readingTimeMinutes: body.readingTimeMinutes ?? null,
    pendingBody: false,
    bodyFailed: false,
  });
}

async function pushIfSignedIn(record, d) {
  const user = d.getUser();
  if (user && record) await d.pushSavedFn(user.id, record);
}

// One pipeline, all channels (spec §4). Local-first: the shell is filed before
// extraction; failure downgrades to bodyFailed, never a lost save.
export async function saveArticle({ url, id, sourceMeta = {}, savedVia = 'url', preloadedArticle = null }, deps = {}) {
  const d = defaultDeps(deps);
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  const finalId = id || articleId(cleanUrl);
  if (!finalId) throw new LibrarySaveError('No link found to save');

  await saveFavorite({
    id: finalId,
    url: cleanUrl,
    title: sourceMeta.title || preloadedArticle?.title || cleanUrl || 'Saved item',
    sourceId: sourceMeta.sourceId ?? null,
    sourceName: sourceMeta.sourceName ?? null,
    sourceShortName: sourceMeta.sourceShortName ?? null,
    sourceColor: sourceMeta.sourceColor ?? null,
    category: sourceMeta.category ?? null,
    thumbnail: sourceMeta.thumbnail ?? null,
    excerpt: sourceMeta.excerpt ?? '',
    savedVia,
    pendingBody: true,
    bodyFailed: false,
  });

  let body = null;
  if (savedVia === 'premium' && sourceMeta.sourceId) {
    // Premium: always go through the authed body-on-demand endpoint — the
    // extractor would hit the paywall and return a teaser (2E §5.3), so
    // preloadedArticle is intentionally not consulted here. Never throws:
    // a failed fetch (expired token, network) downgrades to a bodyFailed
    // shell like every other channel, never a lost save.
    const { fetchPremiumBody } = await import('./premiumApi');
    body = await fetchPremiumBody(sourceMeta.sourceId, finalId).catch(() => null);
  } else if (preloadedArticle && (preloadedArticle.content || preloadedArticle.textContent)) {
    body = preloadedArticle; // heart-from-reader: the app already holds the body
  } else if (/^https?:\/\//i.test(cleanUrl)) {
    body = await extractQueued(cleanUrl, sourceMeta.sourceId, d);
  }

  const record = body
    ? await applyBody(finalId, body, sourceMeta.title || cleanUrl)
    : await patchSavedArticle(finalId, { pendingBody: false, bodyFailed: true });

  await pushIfSignedIn(record, d);
  return record;
}

export async function retrySave(id, deps = {}) {
  const d = defaultDeps(deps);
  const saved = await getFavorite(id);
  if (!saved || !/^https?:\/\//i.test(saved.url || '')) return saved ?? null;
  const body = await extractQueued(saved.url, saved.sourceId, d);
  const record = body
    ? await applyBody(id, body, saved.title)
    : await patchSavedArticle(id, { pendingBody: false, bodyFailed: true });
  await pushIfSignedIn(record, d);
  return record;
}

// Reader helper: a live-fetched article for a saved shell gets attached so the
// item is offline-readable from then on.
export async function attachBodyToSaved(id, article, deps = {}) {
  const d = defaultDeps(deps);
  const saved = await getFavorite(id);
  if (!saved || saved.content) return saved ?? null;
  const record = await applyBody(id, article, saved.title);
  await pushIfSignedIn(record, d);
  return record;
}

// Delete = local remove + cloud tombstone; identical for un-heart and the
// Saved page (spec §6).
export async function deleteSaved({ id, url }, deps = {}) {
  const d = defaultDeps(deps);
  await removeFavorite(id);
  const user = d.getUser();
  if (user) await d.removeSavedFn(user.id, { id, url: url ?? '' });
}

// Drains share-target URLs stashed while the app was gated (spec §5).
export async function processPendingSaves(deps = {}) {
  const d = defaultDeps(deps);
  const pending = await getPendingUrls();
  let saved = 0;
  for (const entry of pending) {
    try {
      await saveArticle({ url: entry.url, savedVia: 'share' }, d);
      saved += 1;
    } catch (err) {
      console.error('[library] pending save failed:', err.message);
    }
    await removePendingUrl(entry.url);
  }
  return saved;
}
