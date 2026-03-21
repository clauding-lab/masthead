import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { fetchAllFeeds } from '../lib/feedParser.js';
import sources from '../lib/sources.json' with { type: 'json' };

const app = new Hono().basePath('/api');

app.use('/*', cors());

// Simple in-memory cache (survives warm Vercel invocations)
let cache = { data: null, fetchedAt: null, key: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/feeds', async (c) => {
  const category = c.req.query('category') || null;
  const source = c.req.query('source') || null;
  const cacheKey = `${category || 'all'}-${source || 'all'}`;

  // Check cache
  if (
    cache.data &&
    cache.key === cacheKey &&
    cache.fetchedAt &&
    Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL
  ) {
    return c.json({
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

    return c.json({ headlines, fetchedAt, cached: false });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return c.json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null }, 500);
  }
});

export default handle(app);
