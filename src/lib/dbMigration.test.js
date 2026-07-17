// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openDB } from 'idb';
import { articleId } from '../../lib/articleId.js';

describe('IndexedDB v2 re-key upgrade (spec D4 / Finding 10)', () => {
  it('re-keys pre-2B favourites and history to the shared articleId', async () => {
    const url = 'https://www.example.com/story?utm_source=mail';
    // Seed a v1 database exactly as a pre-2B device would have it.
    const v1 = await openDB('masthead', 1, {
      upgrade(db) {
        const articles = db.createObjectStore('articles', { keyPath: 'id' });
        articles.createIndex('savedAt', 'savedAt');
        articles.createIndex('isFavorite', 'isFavorite');
        articles.createIndex('sourceId', 'sourceId');
        const history = db.createObjectStore('history', { keyPath: 'id' });
        history.createIndex('readAt', 'readAt');
        db.createObjectStore('pending', { keyPath: 'url' });
      },
    });
    await v1.put('articles', { id: 'abc123def45600', url, title: 'Saved', isFavorite: true, savedAt: '2026-01-01T00:00:00.000Z' });
    await v1.put('history', { id: 'abc123def45600', url, title: 'Saved', readAt: '2026-01-02T00:00:00.000Z' });
    v1.close();

    const db = await import('./db.js'); // opens at v2 → upgrade runs
    const newId = articleId(url);
    const fav = await db.getFavorite(newId);
    expect(fav).toBeDefined();
    expect(fav.title).toBe('Saved');
    expect(fav.url).toBe(url); // url retained (spec §5.3)
    expect(await db.getFavorite('abc123def45600')).toBeUndefined();
    const history = await db.getAllHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(newId);
  });
});
