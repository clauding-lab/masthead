import { extractArticle } from '../lib/extractor.js';
import { assertPublicUrl } from '../lib/urlGuard.js';
import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';

export default async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { allowed } = await checkRateLimit(`extract:${clientIp(req)}`, { limit: 20, windowSec: 60 });
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  const { url, sourceId } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    await assertPublicUrl(url);
  } catch (err) {
    console.error('Extract guard error:', err.message);
    return res.status(400).json({ error: 'URL not allowed' });
  }

  try {
    const article = await extractArticle(url, sourceId);
    return res.status(200).json(article);
  } catch (err) {
    console.error('Extraction error:', err.message);
    return res.status(500).json({ error: 'Failed to extract article' });
  }
}
