import { fetchAllFeeds } from '../lib/feedParser.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sources = require('../lib/sources.json');

// Simple in-memory cache (survives warm Vercel invocations)
let cache = { data: null, fetchedAt: null, key: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const category = url.searchParams.get('category') || null;
  const source = url.searchParams.get('source') || null;
  const cacheKey = `${category || 'all'}-${source || 'all'}`;

  // Check cache
  if (
    cache.data &&
    cache.key === cacheKey &&
    cache.fetchedAt &&
    Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL
  ) {
    return res.status(200).json({
      headlines: cache.data,
      fetchedAt: cache.fetchedAt,
      cached: true,
    });
  }

  try {
    const headlines = await fetchAllFeeds(sources.sources, { category, source });
    const fetchedAt = new Date().toISOString();

    // Update cache
    cache = { data: headlines, fetchedAt, key: cacheKey };

    return res.status(200).json({ headlines, fetchedAt, cached: false });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
  }
}
