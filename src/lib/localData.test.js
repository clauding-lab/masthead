// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { saveFavorite, addToHistory, getAllFavorites, getAllHistory, addPendingUrl, getPendingUrls } from './db.js';
import { clearUserData } from './localData.js';

describe('clearUserData', () => {
  it('wipes IndexedDB records and user localStorage, preserving device prefs', async () => {
    await saveFavorite({ id: 'a1', title: 'T', url: 'https://x.example/a' });
    await addToHistory({ id: 'h1', title: 'H', url: 'https://x.example/h' });
    await addPendingUrl('https://x.example/p');
    localStorage.setItem('masthead-selectedSources', '["bbc"]');
    localStorage.setItem('masthead-onboarded', 'true');
    localStorage.setItem('masthead-theme', 'dark');
    localStorage.setItem('masthead-cookieConsent', 'true');
    localStorage.setItem('masthead-fontSize', '18');
    localStorage.setItem('sb-projectref-auth-token', 'jwt');

    await clearUserData();

    expect(await getAllFavorites()).toEqual([]);
    expect(await getAllHistory()).toEqual([]);
    expect(await getPendingUrls()).toEqual([]);
    expect(localStorage.getItem('masthead-selectedSources')).toBeNull();
    expect(localStorage.getItem('masthead-onboarded')).toBeNull();
    expect(localStorage.getItem('masthead-theme')).toBe('dark');
    expect(localStorage.getItem('masthead-cookieConsent')).toBe('true');
    expect(localStorage.getItem('masthead-fontSize')).toBe('18');
    expect(localStorage.getItem('sb-projectref-auth-token')).toBeNull();
  });
});
