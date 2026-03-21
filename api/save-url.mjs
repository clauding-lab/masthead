import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { extractArticle } from '../lib/extractor.js';

const app = new Hono().basePath('/api');

app.use('/*', cors());

app.post('/save-url', async (c) => {
  // Validate bearer token
  const authHeader = c.req.header('Authorization');
  const token = process.env.SAVE_URL_TOKEN;

  if (token) {
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  const body = await c.req.json();
  const { url } = body;

  if (!url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  try {
    new URL(url);
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  try {
    const article = await extractArticle(url);
    return c.json({ success: true, article });
  } catch (err) {
    console.error('Save-url extraction error:', err.message);
    return c.json(
      { success: false, error: 'Failed to extract article', message: err.message },
      500
    );
  }
});

export default handle(app);
