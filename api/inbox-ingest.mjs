import { verifyIngestSecret } from '../lib/ingestAuth.js';
import { ingestEmail } from '../lib/inboxIngest.js';
import { MAX_RAW_BYTES } from '../lib/inboxConfig.js';

// Server-to-server only: the secret is the gate, not CORS (spec §5.1). No
// applyCors call — a browser origin is never a legitimate caller here.
const INGEST_HEADER = 'x-masthead-ingest';

class RawBodyTooLargeError extends Error {}

// Vercel only parses the body when content-type says so; the Worker sends
// application/octet-stream, so req.body arrives unparsed in production.
// Some environments (dev mocks, certain runtimes) hand us an already-
// buffered/string body on req.body — use it directly when present.
// Otherwise accumulate the raw stream ourselves, aborting once the total
// exceeds MAX_RAW_BYTES so a hostile or misbehaving sender can never grow
// unbounded memory here (ingestEmail has its own raw-size gate too, but
// that one only runs after the whole body is already in memory).
function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_RAW_BYTES) {
        settled = true;
        reject(new RawBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export default async function handler(req, res) {
  // Every response, including every error path, carries the verdict header
  // (spec §3 "verdict authentication" — the Worker only trusts a response as
  // OUR verdict when this header is present).
  res.setHeader(INGEST_HEADER, '1');

  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'method_not_allowed' });
  }

  if (!verifyIngestSecret(req)) {
    // Never log the secret or the header value.
    return res.status(401).json({ code: 'unauthorized' });
  }

  try {
    const rawBuffer = await readRawBody(req);
    const envelopeTo = req.headers['x-envelope-to'];
    const { status, code } = await ingestEmail({ envelopeTo, rawBuffer });
    return res.status(status).json({ code });
  } catch (err) {
    if (err instanceof RawBodyTooLargeError) {
      return res.status(413).json({ code: 'message_too_large' });
    }
    console.error('[inbox-ingest] request failed:', err.name || 'Error');
    return res.status(500).json({ code: 'internal_error' });
  }
}
