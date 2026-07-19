// lib/premiumService.js (Task 5 scope — Task 6 extends this file)
// Premium orchestration (spec §4). Validation is add-time only; error DETAIL
// never reaches the caller (anti-oracle — the route returns one generic 422).
import { fetchRawItems, extractThumbnail } from './feedParser.js';
import { articleId } from './articleId.js';
import { registrableDomain } from './hostHint.js';
import { getOwnedFeedsWithUrls } from './premiumRepo.js';
import { secretParts, redactString, redactContentHtml } from './premiumRedact.js';
import { sanitizeExtractedHtml } from './sanitizeServer.js';

export class PremiumValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PremiumValidationError';
  }
}

export const PREMIUM_TIMEOUT_MS = 3000;

export async function validateFeedUrl(url, { fetchRaw = fetchRawItems } = {}) {
  try {
    const { items, title, finalUrl } = await fetchRaw({ feedUrl: url }, { timeoutMs: 8000 });
    if (!items || items.length === 0) throw new PremiumValidationError('no items');
    return { title: title || '', finalUrl };
  } catch (err) {
    if (err instanceof PremiumValidationError) throw err;
    throw new PremiumValidationError('validation failed');
  }
}

export const MAX_PREMIUM_IDS = 10;
export const PREMIUM_CACHE_TTL_MS = 90_000;
export const MAX_BODY_CHARS = 500_000;

// Single-flight raw-items cache per feed row (spec §4.2): tab switches and
// the body endpoint reuse one publisher hit per TTL window — this is also our
// publisher-politeness throttle for paid feeds.
let cache = new Map();

export function resetPremiumCacheForTests() {
  cache = new Map();
}

export async function resolvePremiumSources(userId, premiumIds, deps = {}) {
  const get = deps.getOwned || getOwnedFeedsWithUrls;
  const ids = (premiumIds || []).filter((x) => typeof x === 'string').slice(0, MAX_PREMIUM_IDS);
  if (ids.length === 0) return [];
  return get(userId, ids);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('premium timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function cachedRawItems(def, deps) {
  const fetchRaw = deps.fetchRaw || fetchRawItems;
  const now = Date.now();
  const slot = cache.get(def.id);
  if (slot && now - slot.at < PREMIUM_CACHE_TTL_MS) return slot.promise;
  const promise = withTimeout(
    fetchRaw({ feedUrl: def.url }, { timeoutMs: PREMIUM_TIMEOUT_MS }),
    PREMIUM_TIMEOUT_MS
  ).then((result) => {
    // Redirect drift (spec §5.3): content from a registrable domain the user
    // never approved is treated as a rejected feed, never silently rendered.
    if (result.finalUrl && registrableDomain(result.finalUrl) !== def.hostHint) {
      const err = new Error('host drift');
      err.status = 403;
      throw err;
    }
    return result;
  }).catch((err) => {
    if (cache.get(def.id)?.promise === promise) cache.delete(def.id);
    throw err;
  });
  cache.set(def.id, { at: now, promise });
  return promise;
}

function itemBody(item) {
  const body = item['content:encoded'] || item.content || '';
  return typeof body === 'string' ? body : '';
}

function mapPremiumItem(item, def, parts) {
  const id = articleId(item);
  if (!id) return null;
  const snippet = typeof item.contentSnippet === 'string' ? item.contentSnippet.trim() : '';
  return {
    id,
    title: redactString(item.title?.trim() || (snippet ? snippet.split('\n')[0].slice(0, 140) : 'Untitled'), parts),
    url: redactString(item.link || '', parts),
    sourceId: def.id,
    premiumFeedId: def.id,
    sourceName: def.label,
    sourceShortName: def.label.slice(0, 3).toUpperCase(),
    sourceColor: '#666666',
    category: def.category,
    thumbnail: redactString(extractThumbnail(item) || '', parts) || null,
    publishedAt: item.pubDate || item.isoDate ? new Date(item.pubDate || item.isoDate).toISOString() : new Date().toISOString(),
    isPaywall: false,
    isPremium: true,
    hasBody: itemBody(item).length > 0,
  };
}

export async function fetchPremiumHeadlines(defs, deps = {}) {
  const headlines = [];
  const premiumStatus = [];
  let succeeded = 0;
  await Promise.all(
    defs.map(async (def) => {
      const parts = secretParts(def.url);
      try {
        const { items } = await cachedRawItems(def, deps);
        for (const item of items) {
          try {
            const mapped = mapPremiumItem(item, def, parts);
            if (mapped) headlines.push(mapped);
          } catch { /* one bad item must not sink the feed */ }
        }
        succeeded++;
        premiumStatus.push({ id: def.id, ok: true });
      } catch (err) {
        // Custody rule 4: id + hostHint only — err.message may embed the URL.
        const rejected = err && [401, 403, 404, 410].includes(err.status);
        console.log(`[premium] ${def.id} (${def.hostHint}): FAILED (${rejected ? 'rejected' : 'unavailable'})`);
        premiumStatus.push({ id: def.id, ok: false, reason: rejected ? 'rejected' : 'unavailable' });
      }
    })
  );
  headlines.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return { headlines, stats: { total: defs.length, succeeded, failed: defs.length - succeeded }, premiumStatus };
}

export async function getPremiumArticleBody(userId, feedId, targetArticleId, deps = {}) {
  const [def] = await resolvePremiumSources(userId, [feedId], deps);
  if (!def) return null;
  const parts = secretParts(def.url);
  let items;
  try {
    ({ items } = await cachedRawItems(def, deps));
  } catch {
    console.log(`[premium] ${def.id} (${def.hostHint}): body fetch FAILED`);
    return null;
  }
  const item = items.find((i) => articleId(i) === targetArticleId);
  if (!item) return null;
  const raw = itemBody(item);
  if (!raw) return null;
  const content = redactContentHtml(sanitizeExtractedHtml(raw), parts).slice(0, MAX_BODY_CHARS);
  return {
    title: redactString(item.title?.trim() || 'Untitled', parts),
    url: redactString(item.link || '', parts),
    content,
  };
}
