// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { putHistoryEntry, getAllHistory } from './db.js';

describe('putHistoryEntry', () => {
  it('preserves the provided readAt timestamp', async () => {
    await putHistoryEntry({ id: 'r1', title: 'Remote', url: 'https://x.example', readAt: '2026-01-01T00:00:00.000Z' });
    const all = await getAllHistory();
    const entry = all.find((h) => h.id === 'r1');
    expect(entry.readAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
