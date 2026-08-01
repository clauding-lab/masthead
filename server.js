import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { extractArticle } from './lib/extractor.js';
import { getHeadlinesForSources, getCatalogHeadlines } from './lib/feedService.js';
import { verifyIngestSecret } from './lib/ingestAuth.js';
import { ingestEmail } from './lib/inboxIngest.js';

const app = new Hono();
app.use('/*', cors());

app.get('/api/feeds', async (c) => {
  const category = c.req.query('category') || null;
  const source = c.req.query('source') || null;
  try {
    const { headlines, feedStats, status } = await getCatalogHeadlines({ category, source });
    if (status !== 200) {
      return c.json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats }, 503);
    }
    return c.json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
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

app.post('/api/feeds', async (c) => {
  const body = await c.req.json();
  const { sources: customSources, category } = body;
  if (!customSources || !Array.isArray(customSources) || customSources.length === 0) {
    return c.json({ error: 'sources array is required' }, 400);
  }
  if (customSources.length > 30) {
    return c.json({ error: 'Too many sources (max 30)' }, 400);
  }
  try {
    const { headlines, feedStats, status } = await getHeadlinesForSources(customSources, { category: category || null });
    if (status !== 200) {
      return c.json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats }, 503);
    }
    return c.json({ headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats });
  } catch (err) {
    console.error('Feed fetch error:', err);
    return c.json({ error: 'Failed to fetch feeds', headlines: [], fetchedAt: null }, 500);
  }
});

app.post('/api/discover-rss', async (c) => {
  // Import handler dynamically for local dev
  const { default: discoverHandler } = await import('./api/discover-rss.mjs');
  // Adapt Hono context to Node-style req/res
  const body = await c.req.json();
  const result = await new Promise((resolve) => {
    const fakeRes = {
      _status: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(code) { this._status = code; return this; },
      json(data) { resolve({ status: this._status, data }); return this; },
      end() { resolve({ status: this._status, data: null }); return this; },
    };
    const fakeReq = { method: 'POST', body, headers: {} };
    discoverHandler(fakeReq, fakeRes);
  });
  return c.json(result.data, result.status);
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

// Dev mirror of api/inbox-ingest.mjs (landmine 1) — same lib call, adapted
// to Hono. No CORS grant here either: the secret is the gate.
app.post('/api/inbox-ingest', async (c) => {
  c.header('x-masthead-ingest', '1');

  if (!verifyIngestSecret({ headers: { 'x-ingest-secret': c.req.header('x-ingest-secret') } })) {
    return c.json({ code: 'unauthorized' }, 401);
  }

  try {
    const rawBuffer = Buffer.from(await c.req.arrayBuffer());
    const envelopeTo = c.req.header('x-envelope-to');
    const { status, code } = await ingestEmail({ envelopeTo, rawBuffer });
    return c.json({ code }, status);
  } catch (err) {
    console.error('[inbox-ingest] request failed:', err.name || 'Error');
    return c.json({ code: 'internal_error' }, 500);
  }
});

const port = 3001;
console.log(`Masthead API server running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
