// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/premiumApi', () => ({
  listPremiumFeeds: vi.fn(),
  addPremiumFeed: vi.fn(),
  patchPremiumFeed: vi.fn(),
  deletePremiumFeed: vi.fn(),
  fetchPremiumBody: vi.fn(),
  getAccessToken: vi.fn(),
}));

import * as premiumApi from '../lib/premiumApi';
import usePremiumStore from './premiumStore';

const ENABLED_KEY = 'masthead-premiumEnabled';
const SEEN_KEY = 'masthead-premiumSeen';

beforeEach(() => {
  localStorage.clear();
  usePremiumStore.setState({ feeds: [], enabledIds: [] });
  vi.clearAllMocks();
});

describe('loadFeeds reconciliation (spec §5.2)', () => {
  it('drops enabled ids no longer on the server and auto-enables never-seen server ids', async () => {
    usePremiumStore.setState({ enabledIds: ['A', 'DEAD'] });
    premiumApi.listPremiumFeeds.mockResolvedValue([
      { id: 'A', kind: 'news', label: 'A', category: 'c', hostHint: 'a.com', createdAt: 't' },
      { id: 'B', kind: 'blog', label: 'B', category: 'c', hostHint: 'b.com', createdAt: 't' },
    ]);

    await usePremiumStore.getState().loadFeeds();

    expect(usePremiumStore.getState().enabledIds.slice().sort()).toEqual(['A', 'B']);
    expect(JSON.parse(localStorage.getItem(SEEN_KEY)).sort()).toEqual(['A', 'B']);
  });

  it('a previously-seen id the user disabled stays disabled on the next load', async () => {
    // Simulate state left behind by an earlier loadFeeds + a manual disable of B:
    // B is recorded as seen, but is no longer in enabledIds.
    localStorage.setItem(SEEN_KEY, JSON.stringify(['A', 'B']));
    usePremiumStore.setState({ enabledIds: ['A'] });
    premiumApi.listPremiumFeeds.mockResolvedValue([
      { id: 'A', kind: 'news' },
      { id: 'B', kind: 'blog' },
    ]);

    await usePremiumStore.getState().loadFeeds();

    expect(usePremiumStore.getState().enabledIds).toEqual(['A']);
  });
});

describe('getEnabledPremiumIdsByKind', () => {
  it('returns only enabled ids matching the given kind', () => {
    usePremiumStore.setState({
      feeds: [
        { id: 'A', kind: 'news' },
        { id: 'B', kind: 'blog' },
        { id: 'C', kind: 'news' },
      ],
      enabledIds: ['A', 'B'],
    });

    expect(usePremiumStore.getState().getEnabledPremiumIdsByKind('news')).toEqual(['A']);
  });
});

describe('reset', () => {
  it('empties state and removes both localStorage keys', () => {
    localStorage.setItem(ENABLED_KEY, JSON.stringify(['A']));
    localStorage.setItem(SEEN_KEY, JSON.stringify(['A']));
    usePremiumStore.setState({ feeds: [{ id: 'A' }], enabledIds: ['A'] });

    usePremiumStore.getState().reset();

    expect(usePremiumStore.getState().feeds).toEqual([]);
    expect(usePremiumStore.getState().enabledIds).toEqual([]);
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
    expect(localStorage.getItem(SEEN_KEY)).toBeNull();
  });
});

describe('toggleEnabled', () => {
  it('persists the enabled set on each toggle', () => {
    usePremiumStore.getState().toggleEnabled('X');
    expect(usePremiumStore.getState().enabledIds).toEqual(['X']);
    expect(JSON.parse(localStorage.getItem(ENABLED_KEY))).toEqual(['X']);

    usePremiumStore.getState().toggleEnabled('X');
    expect(usePremiumStore.getState().enabledIds).toEqual([]);
    expect(JSON.parse(localStorage.getItem(ENABLED_KEY))).toEqual([]);
  });
});

describe('addFeed / patchFeed / removeFeed', () => {
  it('addFeed appends the created row, enables it, and records it as seen', async () => {
    premiumApi.addPremiumFeed.mockResolvedValue({ id: 'N', kind: 'news' });

    const row = await usePremiumStore.getState().addFeed({ url: 'https://x', kind: 'news' });

    expect(row).toEqual({ id: 'N', kind: 'news' });
    expect(usePremiumStore.getState().feeds).toEqual([{ id: 'N', kind: 'news' }]);
    expect(usePremiumStore.getState().enabledIds).toEqual(['N']);
    expect(JSON.parse(localStorage.getItem(SEEN_KEY))).toEqual(['N']);
  });

  it('patchFeed replaces the matching feed with the server response', async () => {
    usePremiumStore.setState({ feeds: [{ id: 'A', label: 'old' }] });
    premiumApi.patchPremiumFeed.mockResolvedValue({ id: 'A', label: 'new' });

    await usePremiumStore.getState().patchFeed('A', { label: 'new' });

    expect(usePremiumStore.getState().feeds).toEqual([{ id: 'A', label: 'new' }]);
  });

  it('removeFeed drops the feed and its enabled id, and persists', async () => {
    usePremiumStore.setState({ feeds: [{ id: 'A' }, { id: 'B' }], enabledIds: ['A', 'B'] });
    premiumApi.deletePremiumFeed.mockResolvedValue({ deleted: true });

    await usePremiumStore.getState().removeFeed('A');

    expect(usePremiumStore.getState().feeds).toEqual([{ id: 'B' }]);
    expect(usePremiumStore.getState().enabledIds).toEqual(['B']);
    expect(JSON.parse(localStorage.getItem(ENABLED_KEY))).toEqual(['B']);
  });
});
