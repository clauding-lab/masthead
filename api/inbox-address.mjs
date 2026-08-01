// api/inbox-address.mjs — signed-in user's ingest-address lifecycle (spec
// §7.1 / Task 8). Client contract for the 3B Inbox UI: response shape and
// keys are exact.
//
// Row-preserving verbs only (ledgered carry-forward): DELETE disables the
// address via disableSlug (slug -> null) — it never deletes the address row
// or touches user_inbox_messages. POST {} is idempotent (ensureAddress,
// never rotateSlug); POST { regenerate: true } is the only path that
// rotates. Browser-facing (unlike api/inbox-ingest.mjs, which is
// Worker-facing and deliberately has no CORS) — applyCors is required here.
import { applyCors, clientIp } from '../lib/httpGuards.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { requireUser, AuthError } from '../lib/authVerify.js';
import { INGEST_DOMAIN } from '../lib/inboxConfig.js';
import { getAddressRow, ensureAddress, rotateSlug, disableSlug, quotaSnapshot } from '../lib/inboxRepo.js';

function parseBody(req) {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    return null;
  }
}

function composeAddress(slug) {
  return slug ? `${slug}@${INGEST_DOMAIN}` : null;
}

// row may be null — no address row has ever been created for this user.
function quotaFields(row) {
  return {
    overQuotaSince: row ? row.overQuotaSince : null,
    deferredCount: row ? row.deferredCount : 0,
  };
}

export default async function handler(req, res) {
  applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ipLimit = await checkRateLimit(`inbox-addr:${clientIp(req)}`, { limit: 10, windowSec: 60 });
  if (!ipLimit.allowed) return res.status(429).json({ error: 'Too many requests' });

  let userId;
  try {
    ({ userId } = await requireUser(req));
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(500).json({ error: 'Internal error' });
  }

  const userLimit = await checkRateLimit(`inbox-addr-user:${userId}`, { limit: 10, windowSec: 60 });
  if (!userLimit.allowed) return res.status(429).json({ error: 'Too many requests' });

  try {
    if (req.method === 'GET') {
      const row = await getAddressRow(userId);
      if (!row) {
        return res.status(200).json({ address: null, bytesUsed: 0, messageCount: 0, overQuotaSince: null, deferredCount: 0 });
      }
      const { messageCount, bytesUsed } = await quotaSnapshot(userId);
      return res.status(200).json({ address: composeAddress(row.slug), bytesUsed, messageCount, ...quotaFields(row) });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body === null) return res.status(400).json({ error: 'Invalid JSON' });
      const row = body.regenerate === true ? await rotateSlug(userId) : await ensureAddress(userId);
      const { messageCount, bytesUsed } = await quotaSnapshot(userId);
      return res.status(200).json({ address: composeAddress(row.slug), bytesUsed, messageCount, ...quotaFields(row) });
    }

    if (req.method === 'DELETE') {
      await disableSlug(userId);
      const row = await getAddressRow(userId);
      const { messageCount, bytesUsed } = await quotaSnapshot(userId);
      return res.status(200).json({ address: null, bytesUsed, messageCount, ...quotaFields(row) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[inbox-address] request failed:', err.name || 'Error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
