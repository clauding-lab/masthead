// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsStoreMock } = vi.hoisted(() => ({
  settingsStoreMock: { getEffectiveSourcesByKind: () => [] },
}));

vi.mock('../lib/api', () => ({
  fetchHeadlines: vi.fn(),
  fetchHeadlinesWithSources: vi.fn(),
}));
vi.mock('./settingsStore', () => ({
  default: { getState: () => settingsStoreMock },
}));

import { fetchHeadlines, fetchHeadlinesWithSources } from '../lib/api';
import useFeedStore, { useBlogsFeedStore, selectNewsRequest, selectBlogsRequest } from './feedStore';

// Every test starts with zero enabled sources of any kind; individual tests
// override settingsStoreMock.getEffectiveSourcesByKind when they need sources.
beforeEach(() => {
  settingsStoreMock.getEffectiveSourcesByKind = () => [];
});

describe('fetchFeeds sequencing', () => {
  beforeEach(() => {
    useFeedStore.setState({ headlines: [], selectedCategory: null });
    fetchHeadlinesWithSources.mockReset();
  });

  it('a slow older request cannot overwrite a newer response', async () => {
    // At least one news source must be enabled so fetchFeeds takes the
    // POST path (2D spec §4.3: empty news never falls back to the GET).
    settingsStoreMock.getEffectiveSourcesByKind = () => [
      { id: 's1', name: 'S', url: 'u', feedUrl: 'f' },
    ];

    let resolveFirst;
    fetchHeadlinesWithSources
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; })
      )
      .mockImplementationOnce(async () => ({
        headlines: [{ id: 'new' }], fetchedAt: 't2',
      }));

    const first = useFeedStore.getState().fetchFeeds();
    const second = useFeedStore.getState().fetchFeeds();
    await second;
    resolveFirst({ headlines: [{ id: 'stale' }], fetchedAt: 't1' });
    await first;

    expect(useFeedStore.getState().headlines).toEqual([{ id: 'new' }]);
  });
});

describe('store factory (2D spec §4.2)', () => {
  it('news and blogs instances hold independent state', () => {
    useFeedStore.setState({ selectedCategory: null });
    useBlogsFeedStore.setState({ selectedCategory: null });
    useBlogsFeedStore.getState().setCategory('economics');
    expect(useFeedStore.getState().selectedCategory).toBeNull();
    expect(useBlogsFeedStore.getState().selectedCategory).toBe('economics');
  });

  it('a kind-scoped surface with zero enabled sources and fallbackToCatalog:false makes no network call (2D spec §4.3)', async () => {
    fetchHeadlines.mockReset();
    fetchHeadlinesWithSources.mockReset();
    useBlogsFeedStore.setState({
      headlines: [], selectedCategory: null, fetchedAt: null, isLoading: false, error: null,
    });

    await useBlogsFeedStore.getState().fetchFeeds();

    expect(fetchHeadlines).not.toHaveBeenCalled();
    expect(fetchHeadlinesWithSources).not.toHaveBeenCalled();
    const state = useBlogsFeedStore.getState();
    expect(state.headlines).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.fetchedAt).toEqual(expect.any(String));
    expect(state.fetchedAt).toBeTruthy();
  });

  it('the news surface with zero enabled news sources makes no network call and never falls back to the catalog (2D spec §4.3)', async () => {
    fetchHeadlines.mockReset();
    fetchHeadlinesWithSources.mockReset();
    useFeedStore.setState({
      headlines: [], selectedCategory: null, fetchedAt: null, isLoading: false, error: null,
    });

    await useFeedStore.getState().fetchFeeds();

    expect(fetchHeadlines).not.toHaveBeenCalled();
    expect(fetchHeadlinesWithSources).not.toHaveBeenCalled();
    const state = useFeedStore.getState();
    expect(state.headlines).toEqual([]);
    expect(state.isLoading).toBe(false);
    expect(state.fetchedAt).toEqual(expect.any(String));
    expect(state.fetchedAt).toBeTruthy();
  });
});

describe('request selectors (2D spec §4.3)', () => {
  const settings = {
    getEffectiveSourcesByKind: (kind) => [{ id: `${kind}-1` }],
  };
  it('news mode requests news sources with the chip category', () => {
    expect(selectNewsRequest(settings, 'macro')).toEqual({
      sources: [{ id: 'news-1' }], category: 'macro', fallbackToCatalog: false,
    });
  });
  it('the social chip requests social sources with no category filter', () => {
    expect(selectNewsRequest(settings, 'social')).toEqual({
      sources: [{ id: 'social-1' }], category: null, fallbackToCatalog: false,
    });
  });
  it('blogs mode requests blog sources', () => {
    expect(selectBlogsRequest(settings, 'finance')).toEqual({
      sources: [{ id: 'blog-1' }], category: 'finance', fallbackToCatalog: false,
    });
  });
});
