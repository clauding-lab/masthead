import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
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

async function fetchScrape(source) {
  if (!source.selectors) return [];
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)' },
    signal: AbortSignal.timeout(6000),
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];

  $(source.selectors.articleList).each((_, el) => {
    const $el = $(el);
    const titleSel = source.selectors.title;
    const linkSel = source.selectors.link;

    const title = $el.find(titleSel.replace(/@.*$/, '')).text().trim();
    let link = '';
    if (linkSel.includes('@')) {
      const [sel, attr] = linkSel.split('@');
      link = $el.find(sel).attr(attr) || '';
    } else {
      link = $el.find(linkSel).attr('href') || '';
    }

    if (link && !link.startsWith('http')) {
      link = new URL(link, source.url).href;
    }

    if (!title || !link) return;

    let thumbnail = null;
    if (source.selectors.thumbnail) {
      const thumbSel = source.selectors.thumbnail;
      if (thumbSel.includes('@')) {
        const [sel, attr] = thumbSel.split('@');
        thumbnail = $el.find(sel).attr(attr) || null;
      }
      if (thumbnail && !thumbnail.startsWith('http')) {
        thumbnail = new URL(thumbnail, source.url).href;
      }
    }

    items.push({
      id: hashUrl(link),
      title,
      url: link,
      sourceId: source.id,
      sourceName: source.name,
      sourceShortName: source.shortName,
      sourceColor: source.color,
      category: source.category,
      thumbnail,
      publishedAt: new Date().toISOString(),
      isPaywall: source.paywall || false,
    });
  });

  return items.slice(0, 15);
}

export async function fetchFeed(source) {
  if (source.feedType === 'rss') {
    return fetchRSS(source);
  } else if (source.feedType === 'scrape') {
    return fetchScrape(source);
  }
  return [];
}

export async function fetchAllFeeds(sources, { category, source: sourceId } = {}) {
  let filtered = sources;
  if (category) filtered = filtered.filter((s) => s.category === category);
  if (sourceId) filtered = filtered.filter((s) => s.id === sourceId);

  const isServerless = !!process.env.VERCEL;
  // Return whatever completes within 25s (leaves 5s buffer for Vercel's 30s limit)
  const overallTimeout = isServerless ? 25000 : 60000;

  const results = await Promise.race([
    Promise.allSettled(filtered.map((s) => fetchFeed(s))),
    new Promise((resolve) =>
      setTimeout(() => resolve(filtered.map(() => ({ status: 'rejected', reason: 'overall timeout' }))), overallTimeout)
    ),
  ]);

  const headlines = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      headlines.push(...result.value);
    }
  }

  headlines.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return headlines;
}
