import { parseHTML } from 'linkedom';
import Parser from 'rss-parser';
import { safeFetch, assertPublicUrl } from '../lib/urlGuard.js';
import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';

const parser = new Parser();

const COMMON_FEED_PATHS = [
  '/feed', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml',
  '/feeds/posts/default', '/blog/feed', '/blog/rss.xml',
];

async function fetchWithTimeout(url, ms = 5000) {
  return safeFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)',
      Accept: 'text/html, application/rss+xml, application/atom+xml, application/xml, text/xml',
    },
    timeoutMs: ms,
    maxBytes: 3 * 1024 * 1024,
  });
}

async function validateFeed(feedUrl) {
  try {
    const { response, text } = await fetchWithTimeout(feedUrl, 5000);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    const body = await text();
    // Quick check: must look like XML
    if (!body.trim().startsWith('<') && !contentType.includes('xml')) return null;
    const feed = await parser.parseString(body);
    if (!feed.items || feed.items.length === 0) return null;
    return {
      feedUrl,
      title: feed.title || feedUrl,
      description: feed.description || '',
      itemCount: feed.items.length,
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { allowed } = await checkRateLimit(`discover:${clientIp(req)}`, { limit: 20, windowSec: 60 });
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  let inputUrl = (body.url || '').trim();
  if (!inputUrl) return res.status(400).json({ error: 'URL is required' });

  // Normalize
  if (!inputUrl.startsWith('http')) inputUrl = `https://${inputUrl}`;
  let baseUrl;
  try {
    baseUrl = new URL(inputUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    await assertPublicUrl(inputUrl);
  } catch (err) {
    console.error('Discover-rss guard error:', err.message);
    return res.status(400).json({ error: 'URL not allowed' });
  }

  const feeds = [];

  // Step 1: Check if the URL itself is a feed
  const directFeed = await validateFeed(inputUrl);
  if (directFeed) {
    feeds.push(directFeed);
    return res.status(200).json({ feeds });
  }

  // Step 2: Fetch HTML and look for <link rel="alternate" type="...rss/atom...">
  try {
    const { response: htmlRes, text: htmlText } = await fetchWithTimeout(inputUrl, 5000);
    if (htmlRes.ok) {
      const html = await htmlText();
      const { document: doc } = parseHTML(html);
      const links = doc.querySelectorAll(
        'link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]'
      );
      for (const link of links) {
        let href = link.getAttribute('href');
        if (!href) continue;
        if (!href.startsWith('http')) href = new URL(href, baseUrl.origin).href;
        const validated = await validateFeed(href);
        if (validated) {
          validated.title = link.getAttribute('title') || validated.title;
          feeds.push(validated);
        }
      }
    }
  } catch {
    // Page fetch failed, continue to probe common paths
  }

  if (feeds.length > 0) {
    return res.status(200).json({ feeds });
  }

  // Step 3: Probe common feed paths
  const probes = COMMON_FEED_PATHS.map((path) => {
    const probeUrl = `${baseUrl.origin}${path}`;
    return validateFeed(probeUrl);
  });

  const results = await Promise.all(probes);
  for (const result of results) {
    if (result) feeds.push(result);
  }

  if (feeds.length === 0) {
    return res.status(200).json({ feeds: [], message: 'No RSS Available' });
  }

  return res.status(200).json({ feeds });
}
