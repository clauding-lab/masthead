// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api', () => ({
  fetchHeadlines: vi.fn(),
  fetchHeadlinesWithSources: vi.fn(),
}));
vi.mock('./settingsStore', () => ({
  default: { getState: () => ({ getEffectiveSourcesByKind: () => [] }) },
}));

import { fetchHeadlines, fetchHeadlinesWithSources } from '../lib/api';
import useFeedStore, { useBlogsFeedStore, selectNewsRequest, selectBlogsRequest } from './feedStore';

describe('fetchFeeds sequencing', () => {
  beforeEach(() => {
    useFeedStore.setState({ headlines: [], selectedCategory: null });
    fetchHeadlines.mockReset();
  });

  it('a slow older request cannot overwrite a newer response', async () => {
    let resolveFirst;
    fetchHeadlines
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
});

describe('request selectors (2D spec §4.3)', () => {
  const settings = {
    getEffectiveSourcesByKind: (kind) => [{ id: `${kind}-1` }],
  };
  it('news mode requests news sources with the chip category', () => {
    expect(selectNewsRequest(settings, 'macro')).toEqual({
      sources: [{ id: 'news-1' }], category: 'macro', fallbackToCatalog: true,
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
