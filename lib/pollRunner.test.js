import { describe, it, expect, vi } from 'vitest';
import { runPoll } from './pollRunner.js';

const HEADLINES = [
  { id: 'a'.repeat(16), sourceId: 'daily-star', url: 'https://x.com/a', title: 'A' },
];

describe('runPoll', () => {
  it('happy path: fetch → upsert → prune, returns 200 with counts', async () => {
    const upsert = vi.fn().mockResolvedValue(1);
    const pruneStore = vi.fn().mockResolvedValue(2);
    const result = await runPoll({
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: HEADLINES, stats: { total: 10, succeeded: 9, failed: 1 } }),
      upsert, pruneStore,
    });
    expect(result).toMatchObject({ ok: true, status: 200, upserted: 1, pruned: 2 });
    expect(upsert).toHaveBeenCalledWith(HEADLINES);
    expect(pruneStore).toHaveBeenCalledWith({ maxAgeDays: 14 });
  });
  it('fails loud with 503 when every feed failed', async () => {
    const upsert = vi.fn();
    const result = await runPoll({
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: [], stats: { total: 10, succeeded: 0, failed: 10 } }),
      upsert, pruneStore: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('lets an upsert failure propagate (handler maps it to 503)', async () => {
    await expect(runPoll({
      fetchFeeds: vi.fn().mockResolvedValue({ headlines: HEADLINES, stats: { total: 10, succeeded: 9, failed: 1 } }),
      upsert: vi.fn().mockRejectedValue(new Error('db down')),
      pruneStore: vi.fn(),
    })).rejects.toThrow('db down');
  });
});
