import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { getHeadlinesForSources, getCatalogHeadlines } from '../lib/feedService.js';
import { requireUser, AuthError } from '../lib/authVerify.js';

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
    const { sources: customSources, category, premiumIds } = body || {};
    const hasPremiumRequest = Array.isArray(premiumIds) && premiumIds.length > 0;
    if (!Array.isArray(customSources) || (customSources.length === 0 && !hasPremiumRequest)) {
      return res.status(400).json({ error: 'sources array is required' });
    }
    if (customSources.length > 30) {
      return res.status(400).json({ error: 'Too many sources (max 30)' });
    }

    // Premium is optional and additive: any failure here (missing/invalid
    // token, or the per-user limiter) omits premium — it never fails the
    // whole feed request, which stays catalog+custom-only on 200.
    let premium = null;
    let premiumAuthFailed = false;
    if (hasPremiumRequest) {
      try {
        const { userId } = await requireUser(req);
        const { allowed: premiumAllowed } = await checkRateLimit(`premium-fetch:${userId}`, { limit: 30, windowSec: 60 });
        if (premiumAllowed) premium = { userId, ids: premiumIds };
      } catch (err) {
        if (err instanceof AuthError) premiumAuthFailed = true;
        else throw err;
      }
    }

    try {
      const { headlines, feedStats, status, premiumStatus } = await getHeadlinesForSources(customSources, {
        category: category || null,
        ...(premium ? { premium } : {}),
      });
      if (status !== 200) {
        return res.status(status).json({ error: 'Feeds temporarily unavailable', headlines: [], feedStats });
      }
      const payload = { headlines, fetchedAt: new Date().toISOString(), cached: false, feedStats };
      if (hasPremiumRequest) payload.premiumStatus = premiumStatus || [];
      if (premiumAuthFailed) payload.premiumAuthFailed = true;
      return res.status(200).json(payload);
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
