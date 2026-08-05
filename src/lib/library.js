import { articleId } from '../../lib/articleId.js';
import { extractArticle as apiExtract } from './api';
import {
  saveFavorite, removeFavorite, getFavorite, patchSavedArticle,
  getPendingUrls, removePendingUrl,
} from './db';
import { pushSaved, removeSaved } from './sync';
import { isInboxPermalink, inboxPermalink } from './inboxPermalink';
import { blockRemoteImages } from './emailImages';
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

// Premium records must never reach the extractor (landmine 18); inbox
// records must never reach it either — same class of bug, same fix shape.
// `savedVia` does NOT survive a cloud round-trip (`localFromSavedRow` in
// sync.js hardcodes 'sync' on every pulled row), so the durable half of
// this predicate is the URL shape: `isInboxPermalink` matches the minted
// `/inbox/message/<uuid>` path regardless of which device or sync pass
// wrote the record. (Task 17, landmine 18 extension.)
export function isInboxRecord(rec) {
  return rec?.savedVia === 'inbox' || isInboxPermalink(rec?.url || '');
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
//
// A premium record (2E fix wave 1) must never resolve to 'live' — that
// branch feeds the extractor, which returns the publisher's paywall teaser,
// never the paid body. A bodyless premium record resolves to 'premium'
// (refetch via the authed endpoint) when its feed id is on the record, or
// 'shell' (terminal, no fetch) when it isn't.
export function resolveReaderSource(saved, url) {
  if (saved && (saved.content || saved.textContent)) return 'stored';
  if (saved && saved.savedVia === 'premium') return saved.sourceId ? 'premium' : 'shell';
  // A body-less inbox record must never resolve to 'live' — the URL is the
  // app's own minted permalink, and 'live' feeds the extractor, which would
  // fetch the SPA shell, not the newsletter body (Task 17, landmine 18
  // extension). Terminal, same as a sourceId-less premium shell above.
  if (saved && isInboxRecord(saved)) return 'shell';
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
  } else if (isInboxRecord({ savedVia, url: cleanUrl })) {
    // CRITICAL: this guard must sit BEFORE the URL-shaped branch below, not
    // inside it. A body-less inbox message's url IS an https:// permalink,
    // so without this early return it would fall straight into
    // extractQueued against the permalink — fetching the app's own SPA
    // shell, not the newsletter (Task 17, landmine 18 extension). Filed as
    // a bodyFailed shell like any other refused channel.
    body = null;
  } else if (/^https?:\/\//i.test(cleanUrl)) {
    body = await extractQueued(cleanUrl, sourceMeta.sourceId, d);
  }

  const record = body
    ? await applyBody(finalId, body, sourceMeta.title || cleanUrl)
    : await patchSavedArticle(finalId, { pendingBody: false, bodyFailed: true });

  await pushIfSignedIn(record, d);
  return record;
}

// Heart-to-library for a newsletter (Task 17). Mints the permalink
// (`inboxPermalink`) that stands in for a normal article's URL, then routes
// the body through saveArticle's ordinary preloadedArticle channel — the
// capContent clamp and articleId(url) id derivation come for free from
// there, no re-implementation needed.
//
// Controller ruling (T16 re-review carry-forward — read-receipt via the
// Saved surface): the reader renders a saved record's content with NO
// remote-image blocking (ReaderPage's sanitizeArticleHtml path, unlike
// InboxMessagePage's sanitizeEmailHtml + blockRemoteImages pairing), so a
// hearted newsletter would otherwise fire its tracking pixels every time it
// is reopened from Saved. Fix: store the BLOCKED variant — run html_body
// (already sanitized server-side at ingest, lib/sanitizeEmail.js) through
// blockRemoteImages before it ever reaches saveArticle. The library copy is
// privacy-safe forever; "View original" (web_url) stays the one path to the
// live, unblocked version — web_url itself is never stored on the record.
export async function saveInboxMessage(message, deps = {}) {
  const url = inboxPermalink(message.id);
  const blockedContent = message.html_body ? blockRemoteImages(message.html_body).html : null;
  return saveArticle({
    url,
    savedVia: 'inbox',
    preloadedArticle: {
      title: message.subject || '(no subject)',
      byline: message.from_name || message.from_email || null,
      content: blockedContent,
      textContent: message.text_body || null,
      excerpt: message.excerpt || null,
    },
  }, deps);
}

export async function retrySave(id, deps = {}) {
  const d = defaultDeps(deps);
  const saved = await getFavorite(id);
  if (!saved) return null;

  let body = null;
  if (saved.savedVia === 'premium') {
    // Premium: retry through the authed body-on-demand endpoint — never the
    // extractor, which would return the publisher's paywall teaser and
    // silently overwrite the paid body (2E fix wave 1). A record with no
    // feed id on file has nothing to retry against; body stays null.
    if (saved.sourceId) {
      const { fetchPremiumBody } = await import('./premiumApi');
      body = await fetchPremiumBody(saved.sourceId, id).catch(() => null);
    }
  } else if (isInboxRecord(saved)) {
    // Never re-extract an inbox permalink — same ban as saveArticle above,
    // and it must stay in force after a cloud sync round-trip, where
    // savedVia has already become 'sync' (Task 17, landmine 18 extension).
    return saved;
  } else if (/^https?:\/\//i.test(saved.url || '')) {
    body = await extractQueued(saved.url, saved.sourceId, d);
  } else {
    return saved;
  }

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
  // A premium record's body may only ever be written by the premium
  // channels (saveArticle/retrySave via fetchPremiumBody) — never by a live
  // extraction attaching itself here, which would silently persist the
  // publisher's paywall teaser as if it were the paid body (2E fix wave 1).
  if (saved.savedVia === 'premium') return saved;
  // Same ban: a live-fetched article must never be written into an inbox
  // record's body — if a fetch against the permalink ever ran, it hit the
  // SPA shell, not the newsletter (Task 17, landmine 18 extension); this
  // must also hold after a cloud sync round-trip (savedVia now 'sync').
  if (isInboxRecord(saved)) return saved;
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
