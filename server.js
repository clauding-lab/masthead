import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { fetchAllFeeds } from './lib/feedParser.js';
import { extractArticle } from './lib/extractor.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sources = require('./lib/sources.json');

const app = new Hono();
app.use('/*', cors());

// Simple in-memory cache
let cache = { data: null, fetchedAt: null, key: null };
const CACHE_TTL = 5 * 60 * 1000;

app.get('/api/feeds', async (c) => {
  const category = c.req.query('category') || null;
  const source = c.req.query('source') || null;
  const cacheKey = `${category || 'all'}-${source || 'all'}`;

  if (
    cache.data &&
    cache.key === cacheKey &&
    cache.fetchedAt &&
    Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL
  ) {
    return c.json({ headlines: cache.data, fetchedAt: cache.fetchedAt, cached: true });
  }

  try {
    const headlines = await fetchAllFeeds(sources.sources, { category, source });
    const fetchedAt = new Date().toISOString();
    cache = { data: headlines, fetchedAt, key: cacheKey };
    return c.json({ headlines, fetchedAt, cached: false });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return c.json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null }, 500);
  }
});

app.post('/api/extract', async (c) => {
  const body = await c.req.json();
  const { url, sourceId } = body;

  if (!url) return c.json({ error: 'URL is required' }, 400);

  try {
    new URL(url);
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  try {
    const article = await extractArticle(url, sourceId);
    return c.json(article);
  } catch (err) {
    console.error('Extraction error:', err.message);
    return c.json({ error: 'Failed to extract article', message: err.message }, 500);
  }
});

app.post('/api/save-url', async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = process.env.SAVE_URL_TOKEN;
  if (token && (!authHeader || authHeader !== `Bearer ${token}`)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const { url } = body;
  if (!url) return c.json({ error: 'URL is required' }, 400);

  try {
    new URL(url);
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  try {
    const article = await extractArticle(url);
    return c.json({ success: true, article });
  } catch (err) {
    console.error('Save-url error:', err.message);
    return c.json({ success: false, error: err.message }, 500);
  }
});

const port = 3001;
console.log(`Masthead API server running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
