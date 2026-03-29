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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // POST: custom source list from user
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    const { sources: customSources, category } = body || {};
    if (!customSources || !Array.isArray(customSources) || customSources.length === 0) {
      return res.status(400).json({ error: 'sources array is required' });
    }
    try {
      const headlines = await fetchAllFeeds(customSources, { category });
      return res.status(200).json({ headlines, fetchedAt: new Date().toISOString(), cached: false });
    } catch (err) {
      console.error('Feed fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
    }
  }

  // GET: default sources
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
    cache = { data: headlines, fetchedAt, key: cacheKey };
    return res.status(200).json({ headlines, fetchedAt, cached: false });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
  }
}
