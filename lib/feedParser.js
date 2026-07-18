import Parser from 'rss-parser';
import { safeFetch } from './urlGuard.js';
import { articleId } from './articleId.js';

// rss-parser's default field whitelist drops any `media:*` element — the
// media RSS namespace extractThumbnail() reads from isn't parsed at all
// without this. Discovered via real Mastodon fixture capture (Task 4).
const MEDIA_CUSTOM_FIELDS = [
  ['media:content', 'media:content', { keepArray: true }],
  ['media:thumbnail', 'media:thumbnail', { keepArray: true }],
];

export const parserOptions = { customFields: { item: MEDIA_CUSTOM_FIELDS } };
const parser = new Parser(parserOptions);

function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function fetchRSS(source) {
  const { text } = await safeFetch(source.feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    timeoutMs: 6000,
    maxBytes: 3 * 1024 * 1024,
  });
  const xml = await text();
  const feed = await parser.parseString(xml);

  return mapFeedItems((feed.items || []).slice(0, 15), source);
}

function firstMediaUrl(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.$?.url || null;
}

export function extractThumbnail(item) {
  const fromContent = firstMediaUrl(item['media:content']);
  if (fromContent) return fromContent;
  const fromThumb = firstMediaUrl(item['media:thumbnail']);
  if (fromThumb) return fromThumb;
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image')) return item.enclosure.url;
  const content = item['content:encoded'] || item.content || '';
  const imgMatch = typeof content === 'string' ? content.match(/<img[^>]+src="([^"]+)"/) : null;
  return imgMatch ? imgMatch[1] : null;
}

export function mapFeedItems(items, source) {
  const mapped = [];
  for (const item of items) {
    try {
      const id = articleId(item);
      if (!id) continue; // no link, guid, or title — nothing to key on
      const snippet = typeof item.contentSnippet === 'string' ? item.contentSnippet.trim() : '';
      mapped.push({
        id,
        title: item.title?.trim() || (snippet ? snippet.split('\n')[0].slice(0, 140) : 'Untitled'),
        url: item.link || '',
        sourceId: source.id,
        sourceName: source.name,
        sourceShortName: source.shortName,
        sourceColor: source.color,
        category: source.category,
        thumbnail: extractThumbnail(item),
        publishedAt: parseDate(item.pubDate || item.isoDate),
        isPaywall: source.paywall || false,
      });
    } catch {
      // One malformed item must not sink the feed.
    }
  }
  return mapped;
}

export async function fetchFeed(source) {
  const start = Date.now();
  try {
    const result = await fetchRSS(source);
    console.log(`[feed] ${source.id}: ${result.length} items in ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    console.log(`[feed] ${source.id}: FAILED in ${Date.now() - start}ms - ${err.message}`);
    throw err;
  }
}

export async function fetchAllFeeds(sources, { category, source: sourceId } = {}) {
  let filtered = sources;
  if (category) filtered = filtered.filter((s) => s.category === category);
  if (sourceId) filtered = filtered.filter((s) => s.id === sourceId);

  if (filtered.length === 0) return { headlines: [], stats: { total: 0, succeeded: 0, failed: 0 } };

  const isServerless = !!process.env.VERCEL;
  const perFeedMs = isServerless ? 6000 : 10000;
  const deadlineMs = isServerless ? 20000 : 60000;

  // Wrap each feed in a hard timeout
  function withTimeout(fn, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hard timeout')), ms);
      fn().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  // Collect results as they arrive, return everything by deadline
  const headlines = [];
  let settled = 0;
  let succeeded = 0;
  let failed = 0;

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, deadlineMs);

    for (const source of filtered) {
      withTimeout(() => fetchFeed(source), perFeedMs)
        .then((items) => { headlines.push(...items); succeeded++; })
        .catch(() => { failed++; })
        .finally(() => {
          settled++;
          if (settled >= filtered.length) {
            clearTimeout(timer);
            resolve();
          }
        });
    }
  });

  headlines.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return { headlines, stats: { total: filtered.length, succeeded, failed } };
}
