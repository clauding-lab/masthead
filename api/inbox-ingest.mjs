import { verifyIngestSecret } from '../lib/ingestAuth.js';
import { ingestEmail } from '../lib/inboxIngest.js';
import { MAX_RAW_BYTES } from '../lib/inboxConfig.js';

// Server-to-server only: the secret is the gate, not CORS (spec §5.1). No
// applyCors call — a browser origin is never a legitimate caller here.
const INGEST_HEADER = 'x-masthead-ingest';

class RawBodyTooLargeError extends Error {}
// Vercel parses the body into a plain object when content-type says
// json/form/text — by the time this handler runs, the underlying stream is
// already fully drained, so req.on('data'/'end') below would never fire and
// the stream-accumulation promise would hang until maxDuration (30s), with
// no [ingest] log line to diagnose from. The Worker always sends
// application/octet-stream (never one of those content-types), so this only
// fires for malformed/unexpected traffic.
//
// This is an INFRASTRUCTURE condition, not a deterministic property of the
// message — never map it to a permanent-bounce code (`unparseable`/422 is
// in the Worker's REJECT_CODES). If the runtime ever systemically changed
// how it hands us octet-stream bodies, that would hit every legitimate
// newsletter, and the binding posture is "no failure mode may permanently
// bounce legitimate mail on an infra fault — transient conditions defer."
// The pre-fix hang at least produced a Worker timeout → defer → sender
// retry; this settles the same way on purpose (transient 500), just without
// burning the full maxDuration to get there.
class RawBodyUnavailableError extends Error {}

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

  // Anything else already present on req.body (a parsed object, `{}`, etc.)
  // means the stream is gone — same for a stream the runtime has already
  // marked complete/ended without ever populating req.body. Either way,
  // waiting on 'data'/'end' below would hang forever.
  if (req.body !== undefined || req.readableEnded || req.complete) {
    return Promise.reject(new RawBodyUnavailableError());
  }

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
    if (err instanceof RawBodyUnavailableError) {
      // Transient, never a permanent bounce (see the class comment above):
      // this is an infra condition, not a deterministic property of the
      // message. Same code the generic 500 path below uses — no new code
      // vocabulary — but its own log line so an operator can tell "the
      // runtime stopped handing us Buffers" apart from a generic failure.
      console.error('[inbox-ingest] raw body unavailable (pre-parsed or consumed stream)');
      return res.status(500).json({ code: 'internal_error' });
    }
    console.error('[inbox-ingest] request failed:', err.name || 'Error');
    return res.status(500).json({ code: 'internal_error' });
  }
}
