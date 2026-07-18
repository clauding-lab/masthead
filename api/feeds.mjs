import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { getHeadlinesForSources, getCatalogHeadlines } from '../lib/feedService.js';

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { allowed } = await checkRateLimit(`feeds:${clientIp(req)}`, { limit: 60, windowSec: 60 });
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

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
    if (customSources.length > 30) {
      return res.status(400).json({ error: 'Too many sources (max 30)' });
    }
    try {
      const { headlines, feedStats, status } = await getHeadlinesForSources(customSources, { category: category || null });
      if (status !== 200) {
        return res.status(status).json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats });
      }
      return res.status(200).json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
    } catch (err) {
      console.error('Feed fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
    }
  }

  // GET: catalog sources (store-served; live fallback only when globally cold)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const category = url.searchParams.get('category') || null;
  const source = url.searchParams.get('source') || null;
  try {
    const { headlines, feedStats, status } = await getCatalogHeadlines({ category, source });
    if (status !== 200) {
      return res.status(status).json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats });
    }
    return res.status(200).json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null });
  }
}
