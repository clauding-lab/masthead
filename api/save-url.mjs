import { extractArticle } from '../lib/extractor.js';
import { assertPublicUrl } from '../lib/urlGuard.js';
import { applyCors } from '../lib/httpGuards.js';

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate bearer token
  const authHeader = req.headers['authorization'];
  const token = process.env.SAVE_URL_TOKEN;

  if (token) {
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    await assertPublicUrl(url);
  } catch (err) {
    console.error('Save-url guard error:', err.message);
    return res.status(400).json({ error: 'URL not allowed' });
  }

  try {
    const article = await extractArticle(url);
    return res.status(200).json({ success: true, article });
  } catch (err) {
    console.error('Save-url extraction error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to extract article' });
  }
}
