// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { putHistoryEntry, getAllHistory, saveFavorite, getFavorite, patchSavedArticle } from './db.js';

describe('putHistoryEntry', () => {
  it('preserves the provided readAt timestamp', async () => {
    await putHistoryEntry({ id: 'r1', title: 'Remote', url: 'https://x.example', readAt: '2026-01-01T00:00:00.000Z' });
    const all = await getAllHistory();
    const entry = all.find((h) => h.id === 'r1');
    expect(entry.readAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('patchSavedArticle', () => {
  it('merges fields, stamps updatedAtLocal, preserves the rest', async () => {
    await saveFavorite({ id: 'p1', url: 'https://x.example/a', title: 'T', pendingBody: true });
    const patched = await patchSavedArticle('p1', { content: '<p>b</p>', pendingBody: false });
    expect(patched.content).toBe('<p>b</p>');
    expect(patched.pendingBody).toBe(false);
    expect(patched.title).toBe('T');
    expect(typeof patched.updatedAtLocal).toBe('string');
    const roundTrip = await getFavorite('p1');
    expect(roundTrip.content).toBe('<p>b</p>');
  });
  it('returns null for an unknown id', async () => {
    expect(await patchSavedArticle('nope', { a: 1 })).toBeNull();
  });
});
