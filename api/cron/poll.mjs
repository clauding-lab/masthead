import { verifyCronAuth } from '../../lib/cronAuth.js';
import { runPoll } from '../../lib/pollRunner.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyCronAuth(req)) {
    // Never log the Authorization header or the secret.
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runPoll();
    return res.status(result.status).json(result);
  } catch (err) {
    console.error('[cron/poll] failed:', err.message);
    return res.status(503).json({ ok: false, error: 'poll failed' });
  }
}
