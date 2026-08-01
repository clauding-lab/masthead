import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/inboxPurge.js', () => ({ runInboxPurge: vi.fn() }));
import { runInboxPurge } from '../../lib/inboxPurge.js';
import handler from './inbox-purge.mjs';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
  };
}

describe('api/cron/inbox-purge handler', () => {
  const saved = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 'tok'; vi.mocked(runInboxPurge).mockReset(); });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('405 on disallowed method', async () => {
    const res = fakeRes();
    await handler({ method: 'DELETE', headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });
  it('401 without valid auth; runInboxPurge never runs', async () => {
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);
    expect(runInboxPurge).not.toHaveBeenCalled();
  });
  it('200 with the run result on success', async () => {
    vi.mocked(runInboxPurge).mockResolvedValue({ ok: true, hardDeleted: 3, pressureDeleted: 1 });
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, hardDeleted: 3, pressureDeleted: 1 });
  });
  it('503 when the run throws (fail LOUD in the cron dashboard)', async () => {
    vi.mocked(runInboxPurge).mockRejectedValue(new Error('boom'));
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});
