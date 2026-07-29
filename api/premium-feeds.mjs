import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { requireUser, AuthError } from '../lib/authVerify.js';
import { assertPublicUrl } from '../lib/urlGuard.js';
import { registrableDomain } from '../lib/hostHint.js';
import { validateFeedUrl, getPremiumArticleBody } from '../lib/premiumService.js';
import {
  listFeeds, countFeeds, findByUrl, insertFeed, updateFeedMeta, deleteFeed,
  PremiumCapError, PremiumDuplicateError,
} from '../lib/premiumRepo.js';

const MAX_PREMIUM_FEEDS = 5;
const GENERIC_VALIDATION = { error: 'Could not validate feed URL' };
const KINDS = new Set(['news', 'blog']);

function parseBody(req) {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { allowed } = await checkRateLimit(`premium:${clientIp(req)}`, { limit: 30, windowSec: 60 });
  if (!allowed) return res.status(429).json({ error: 'Too many requests' });

  let userId;
  try {
    ({ userId } = await requireUser(req));
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(500).json({ error: 'Internal error' });
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const feedId = url.searchParams.get('feed');
      const articleId = url.searchParams.get('article');
      if (feedId && articleId) {
        const bodyLimit = await checkRateLimit(`premium-body:${userId}`, { limit: 60, windowSec: 60 });
        if (!bodyLimit.allowed) return res.status(429).json({ error: 'Too many requests' });
        const article = await getPremiumArticleBody(userId, feedId, articleId);
        if (!article) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ article });
      }
      return res.status(200).json({ feeds: await listFeeds(userId) });
    }

    const body = parseBody(req);
    if (body === null) return res.status(400).json({ error: 'Invalid JSON' });

    if (req.method === 'POST') {
      const addLimit = await checkRateLimit(`premium-add:${userId}`, { limit: 10, windowSec: 600 });
      if (!addLimit.allowed) return res.status(429).json({ error: 'Too many requests' });

      const { url, kind, label, category } = body;
      // Cheap checks before ANY network (spec §4.1 order).
      if (typeof url !== 'string' || !/^https:\/\//i.test(url.trim())) {
        return res.status(400).json({ error: 'https required' });
      }
      const cleanUrl = url.trim();
      if (!KINDS.has(kind)) return res.status(400).json({ error: 'kind must be news or blog' });
      if ((await countFeeds(userId)) >= MAX_PREMIUM_FEEDS) {
        return res.status(403).json({ error: `Premium feed limit reached (${MAX_PREMIUM_FEEDS})` });
      }
      if (await findByUrl(userId, cleanUrl)) return res.status(409).json({ error: 'Already added' });

      // Network phase — every failure collapses to one generic 422 (anti-oracle).
      let title, finalUrl;
      try {
        await assertPublicUrl(cleanUrl);
        ({ title, finalUrl } = await validateFeedUrl(cleanUrl));
      } catch {
        // Host-only, never the full url (it may embed a reader token) — and
        // registrableDomain itself can throw on a malformed url, so that
        // must never escape and swallow the 422 (final-review Important 3).
        let host = 'unparseable-host';
        try {
          host = registrableDomain(cleanUrl);
        } catch {}
        console.error('[premium-feeds] validate failed:', host);
        return res.status(422).json(GENERIC_VALIDATION);
      }

      try {
        const row = await insertFeed({
          userId,
          url: cleanUrl,
          label: (typeof label === 'string' && label.trim() ? label.trim() : title || registrableDomain(finalUrl)).slice(0, 200),
          kind,
          category: typeof category === 'string' && category.trim() ? category.trim().slice(0, 50) : 'custom',
          hostHint: registrableDomain(finalUrl),
        });
        return res.status(201).json(row);
      } catch (err) {
        if (err instanceof PremiumCapError) return res.status(403).json({ error: `Premium feed limit reached (${MAX_PREMIUM_FEEDS})` });
        if (err instanceof PremiumDuplicateError) return res.status(409).json({ error: 'Already added' });
        throw err;
      }
    }

    if (req.method === 'PATCH') {
      const { id, label, kind, category } = body;
      if (typeof id !== 'string') return res.status(400).json({ error: 'id required' });
      if (kind !== undefined && !KINDS.has(kind)) return res.status(400).json({ error: 'kind must be news or blog' });
      const row = await updateFeedMeta(userId, id, {
        label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : undefined,
        kind,
        category: typeof category === 'string' && category.trim() ? category.trim().slice(0, 50) : undefined,
      });
      if (!row) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(row);
    }

    if (req.method === 'DELETE') {
      const { id } = body;
      if (typeof id !== 'string') return res.status(400).json({ error: 'id required' });
      const deleted = await deleteFeed(userId, id);
      if (!deleted) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Custody rule 4: never echo err.message — it may embed a URL.
    console.error('[premium-feeds] request failed:', err.name || 'Error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
