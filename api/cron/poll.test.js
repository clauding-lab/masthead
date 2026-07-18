import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/pollRunner.js', () => ({ runPoll: vi.fn() }));
import { runPoll } from '../../lib/pollRunner.js';
import handler from './poll.mjs';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
  };
}

describe('api/cron/poll handler', () => {
  const saved = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 'tok'; vi.mocked(runPoll).mockReset(); });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('405 on disallowed method', async () => {
    const res = fakeRes();
    await handler({ method: 'DELETE', headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });
  it('401 without valid auth; runPoll never runs', async () => {
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);
    expect(runPoll).not.toHaveBeenCalled();
  });
  it('200 with the run result on success', async () => {
    vi.mocked(runPoll).mockResolvedValue({ ok: true, status: 200, upserted: 5, pruned: 0, stats: { total: 10, succeeded: 10, failed: 0 } });
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.upserted).toBe(5);
  });
  it('503 when the run throws (fail LOUD in the cron dashboard)', async () => {
    vi.mocked(runPoll).mockRejectedValue(new Error('boom'));
    const res = fakeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer tok' } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});
