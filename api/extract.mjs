import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { extractArticle } from '../lib/extractor.js';

const app = new Hono().basePath('/api');

app.use('/*', cors());

app.post('/extract', async (c) => {
  const body = await c.req.json();
  const { url, sourceId } = body;

  if (!url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  // Basic URL validation
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
    return c.json(
      { error: 'Failed to extract article', message: err.message },
      500
    );
  }
});

export default handle(app);
