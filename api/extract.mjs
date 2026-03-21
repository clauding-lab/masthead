import { extractArticle } from '../lib/extractor.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, sourceId } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const article = await extractArticle(url, sourceId);
    return res.status(200).json(article);
  } catch (err) {
    console.error('Extraction error:', err.message);
    return res.status(500).json({ error: 'Failed to extract article', message: err.message });
  }
}
