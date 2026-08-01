import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../lib/ingestAuth.js', () => ({
  verifyIngestSecret: vi.fn(),
}));
vi.mock('../lib/inboxIngest.js', () => ({
  ingestEmail: vi.fn(),
}));

import { verifyIngestSecret } from '../lib/ingestAuth.js';
import { ingestEmail } from '../lib/inboxIngest.js';
import { MAX_RAW_BYTES } from '../lib/inboxConfig.js';
import handler from './inbox-ingest.mjs';

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}

// Vercel's req is a readable stream (IncomingMessage) with method/headers.
// body is left undefined unless something upstream pre-buffers it — tests
// that want the stream-accumulation path emit 'data'/'end' manually.
function fakeReq({ method = 'POST', headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  if (body !== undefined) req.body = body;
  return req;
}

function emitStream(req, chunks) {
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
}

beforeEach(() => {
  vi.mocked(verifyIngestSecret).mockReset().mockReturnValue(true);
  vi.mocked(ingestEmail).mockReset().mockResolvedValue({ status: 201, code: 'accepted' });
});

describe('method guard', () => {
  it('GET -> 405 with x-masthead-ingest header, ingestEmail never called', async () => {
    const req = fakeReq({ method: 'GET' });
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ code: 'method_not_allowed' });
    expect(res.headers['x-masthead-ingest']).toBe('1');
    expect(ingestEmail).not.toHaveBeenCalled();
  });
});

describe('auth guard', () => {
  it('bad secret -> 401 with x-masthead-ingest header, ingestEmail never called', async () => {
    vi.mocked(verifyIngestSecret).mockReturnValue(false);
    const req = fakeReq({ body: Buffer.from('raw') });
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ code: 'unauthorized' });
    expect(res.headers['x-masthead-ingest']).toBe('1');
    expect(ingestEmail).not.toHaveBeenCalled();
  });
});

describe('happy path', () => {
  it('pipes envelope header + a Buffer to ingestEmail and relays {status, code} + header', async () => {
    vi.mocked(ingestEmail).mockResolvedValue({ status: 201, code: 'accepted' });
    const req = fakeReq({
      headers: { 'x-envelope-to': 'quiet-harbor-4f2a@masthead.clauding-lab.com' },
      body: Buffer.from('raw email bytes'),
    });
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ code: 'accepted' });
    expect(res.headers['x-masthead-ingest']).toBe('1');
    expect(ingestEmail).toHaveBeenCalledTimes(1);
    const [{ envelopeTo, rawBuffer }] = ingestEmail.mock.calls[0];
    expect(envelopeTo).toBe('quiet-harbor-4f2a@masthead.clauding-lab.com');
    expect(Buffer.isBuffer(rawBuffer)).toBe(true);
    expect(rawBuffer.toString()).toBe('raw email bytes');
  });

  it('relays a non-2xx verdict (e.g. 404 unknown_recipient) with the same header contract', async () => {
    vi.mocked(ingestEmail).mockResolvedValue({ status: 404, code: 'unknown_recipient' });
    const req = fakeReq({ body: Buffer.from('raw') });
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'unknown_recipient' });
    expect(res.headers['x-masthead-ingest']).toBe('1');
  });

  it('reads a streamed body (no pre-buffered req.body) into a real Buffer', async () => {
    const req = fakeReq({ headers: { 'x-envelope-to': 'x@masthead.clauding-lab.com' } });
    emitStream(req, [Buffer.from('chunk-one-'), Buffer.from('chunk-two')]);
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(ingestEmail).toHaveBeenCalledTimes(1);
    const [{ rawBuffer }] = ingestEmail.mock.calls[0];
    expect(Buffer.isBuffer(rawBuffer)).toBe(true);
    expect(rawBuffer.toString()).toBe('chunk-one-chunk-two');
  });

  it('a streamed body exceeding MAX_RAW_BYTES aborts with 413 message_too_large before ingestEmail runs', async () => {
    const req = fakeReq({});
    emitStream(req, [Buffer.alloc(MAX_RAW_BYTES + 1)]);
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ code: 'message_too_large' });
    expect(res.headers['x-masthead-ingest']).toBe('1');
    expect(ingestEmail).not.toHaveBeenCalled();
  });
});

describe('error path', () => {
  it('ingestEmail throws -> 500 with x-masthead-ingest header, error not leaked', async () => {
    vi.mocked(ingestEmail).mockRejectedValue(new Error('boom: secret-detail'));
    const req = fakeReq({ body: Buffer.from('raw') });
    const res = fakeRes();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ code: 'internal_error' });
    expect(res.headers['x-masthead-ingest']).toBe('1');
    expect(JSON.stringify(res.body)).not.toContain('secret-detail');

    consoleSpy.mockRestore();
  });
});
