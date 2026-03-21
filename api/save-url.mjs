import { extractArticle } from '../lib/extractor.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const article = await extractArticle(url);
    return res.status(200).json({ success: true, article });
  } catch (err) {
    console.error('Save-url extraction error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to extract article', message: err.message });
  }
}
