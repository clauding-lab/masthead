import Parser from 'rss-parser';
import crypto from 'crypto';

const parser = new Parser();

function hashUrl(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function fetchRSS(source) {
  // Use fetch with AbortSignal for reliable timeout instead of rss-parser's http
  const res = await fetch(source.feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(6000),
  });
  const xml = await res.text();
  const feed = await parser.parseString(xml);

  return (feed.items || []).slice(0, 15).map((item) => ({
    id: hashUrl(item.link || item.guid || item.title),
    title: item.title?.trim() || 'Untitled',
    url: item.link || '',
    sourceId: source.id,
    sourceName: source.name,
    sourceShortName: source.shortName,
    sourceColor: source.color,
    category: source.category,
    thumbnail: extractThumbnail(item),
    publishedAt: parseDate(item.pubDate || item.isoDate),
    isPaywall: source.paywall || false,
  }));
}

function extractThumbnail(item) {
  if (item['media:content']?.$.url) return item['media:content'].$.url;
  if (item['media:thumbnail']?.$.url) return item['media:thumbnail'].$.url;
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image'))
    return item.enclosure.url;
  const content = item['content:encoded'] || item.content || '';
  const imgMatch = content.match(/<img[^>]+src="([^"]+)"/);
  if (imgMatch) return imgMatch[1];
  return null;
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

  if (filtered.length === 0) return [];

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

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, deadlineMs);

    for (const source of filtered) {
      withTimeout(() => fetchFeed(source), perFeedMs)
        .then((items) => { headlines.push(...items); })
        .catch(() => {})
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
  return headlines;
}
