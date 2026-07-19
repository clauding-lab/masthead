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
vi.mock('../lib/premiumApi', () => ({
  getAccessToken: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({
  supabase: { auth: { refreshSession: vi.fn() } },
}));

import { fetchHeadlines, fetchHeadlinesWithSources } from '../lib/api';
import { getAccessToken } from '../lib/premiumApi';
import { supabase } from '../lib/supabase';
import useFeedStore, { useBlogsFeedStore, selectNewsRequest, selectBlogsRequest } from './feedStore';
import usePremiumStore from './premiumStore';

// Every test starts with zero enabled sources of any kind; individual tests
// override settingsStoreMock.getEffectiveSourcesByKind when they need sources.
// usePremiumStore is the real store (not mocked); reset it to empty here so
// premiumIds default to [] unless a test explicitly enables premium feeds.
beforeEach(() => {
  settingsStoreMock.getEffectiveSourcesByKind = () => [];
  usePremiumStore.setState({ feeds: [], enabledIds: [] });
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

describe('request selectors (2D spec §4.3, shape amended 2E §5.2 with premiumIds)', () => {
  const settings = {
    getEffectiveSourcesByKind: (kind) => [{ id: `${kind}-1` }],
  };
  // NOTE: these three assertions now include `premiumIds: []` — the Task 10
  // interface amendment requires selectors to always return a premiumIds key
  // (usePremiumStore defaults to zero enabled feeds, so it's [] here). This is
  // a spec-mandated shape update, not a loosened assertion.
  it('news mode requests news sources with the chip category', () => {
    expect(selectNewsRequest(settings, 'macro')).toEqual({
      sources: [{ id: 'news-1' }], category: 'macro', fallbackToCatalog: false, premiumIds: [],
    });
  });
  it('the social chip requests social sources with no category filter', () => {
    expect(selectNewsRequest(settings, 'social')).toEqual({
      sources: [{ id: 'social-1' }], category: null, fallbackToCatalog: false, premiumIds: [],
    });
  });
  it('blogs mode requests blog sources', () => {
    expect(selectBlogsRequest(settings, 'finance')).toEqual({
      sources: [{ id: 'blog-1' }], category: 'finance', fallbackToCatalog: false, premiumIds: [],
    });
  });

  it('news mode threads enabled news-kind premiumIds from usePremiumStore', () => {
    usePremiumStore.setState({
      feeds: [{ id: 'p1', kind: 'news' }, { id: 'p2', kind: 'blog' }],
      enabledIds: ['p1', 'p2'],
    });
    expect(selectNewsRequest(settings, 'macro').premiumIds).toEqual(['p1']);
  });

  it('the social chip never includes premiumIds even when premium feeds are enabled', () => {
    usePremiumStore.setState({ feeds: [{ id: 'p1', kind: 'news' }], enabledIds: ['p1'] });
    expect(selectNewsRequest(settings, 'social').premiumIds).toEqual([]);
  });

  it('blogs mode threads enabled blog-kind premiumIds from usePremiumStore', () => {
    usePremiumStore.setState({
      feeds: [{ id: 'p1', kind: 'news' }, { id: 'p2', kind: 'blog' }],
      enabledIds: ['p1', 'p2'],
    });
    expect(selectBlogsRequest(settings, 'finance').premiumIds).toEqual(['p2']);
  });
});

describe('premium request wiring + landmine-16 guard amendment (2E §5.2)', () => {
  beforeEach(() => {
    useFeedStore.setState({
      headlines: [], selectedCategory: null, fetchedAt: null, isLoading: false, error: null,
      premiumIssues: [], premiumAuthFailed: false,
    });
    fetchHeadlinesWithSources.mockReset();
    getAccessToken.mockReset();
    supabase.auth.refreshSession.mockReset();
  });

  it('zero sources + zero premiumIds makes no network call and returns empty headlines (guard direction 1)', async () => {
    settingsStoreMock.getEffectiveSourcesByKind = () => [];

    await useFeedStore.getState().fetchFeeds();

    expect(fetchHeadlinesWithSources).not.toHaveBeenCalled();
    expect(useFeedStore.getState().headlines).toEqual([]);
  });

  it('zero sources + premiumIds present still fetches, with premiumIds and an access token (guard direction 2)', async () => {
    settingsStoreMock.getEffectiveSourcesByKind = () => [];
    usePremiumStore.setState({ feeds: [{ id: 'p1', kind: 'news' }], enabledIds: ['p1'] });
    getAccessToken.mockResolvedValue('tok-1');
    fetchHeadlinesWithSources.mockResolvedValue({ headlines: [{ id: 'h1' }], fetchedAt: 't1' });

    await useFeedStore.getState().fetchFeeds();

    expect(fetchHeadlinesWithSources).toHaveBeenCalledTimes(1);
    const [sources, opts] = fetchHeadlinesWithSources.mock.calls[0];
    expect(sources).toEqual([]);
    expect(opts.premiumIds).toEqual(['p1']);
    expect(opts.accessToken).toBe('tok-1');
    expect(useFeedStore.getState().headlines).toEqual([{ id: 'h1' }]);
  });

  it('non-empty sources plus premiumIds sends both in the request', async () => {
    settingsStoreMock.getEffectiveSourcesByKind = () => [{ id: 's1', name: 'S', url: 'u', feedUrl: 'f' }];
    usePremiumStore.setState({ feeds: [{ id: 'p1', kind: 'news' }], enabledIds: ['p1'] });
    getAccessToken.mockResolvedValue('tok-2');
    fetchHeadlinesWithSources.mockResolvedValue({ headlines: [], fetchedAt: 't1' });

    await useFeedStore.getState().fetchFeeds();

    const [sources, opts] = fetchHeadlinesWithSources.mock.calls[0];
    expect(sources).toEqual([expect.objectContaining({ id: 's1', name: 'S' })]);
    expect(opts.premiumIds).toEqual(['p1']);
    expect(opts.accessToken).toBe('tok-2');
  });

  it('a premiumAuthFailed response refreshes the session and retries exactly once; a second failure sets the flag without looping', async () => {
    settingsStoreMock.getEffectiveSourcesByKind = () => [];
    usePremiumStore.setState({ feeds: [{ id: 'p1', kind: 'news' }], enabledIds: ['p1'] });
    getAccessToken.mockResolvedValueOnce('stale-tok').mockResolvedValueOnce('fresh-tok');
    supabase.auth.refreshSession.mockResolvedValue({});
    fetchHeadlinesWithSources
      .mockResolvedValueOnce({ premiumAuthFailed: true, headlines: [] })
      .mockResolvedValueOnce({ premiumAuthFailed: true, headlines: [] });

    await useFeedStore.getState().fetchFeeds();

    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchHeadlinesWithSources).toHaveBeenCalledTimes(2);
    expect(fetchHeadlinesWithSources.mock.calls[1][1].accessToken).toBe('fresh-tok');
    expect(useFeedStore.getState().premiumAuthFailed).toBe(true);
    expect(useFeedStore.getState().error).toBeNull();
  });

  it('premiumStatus failures land in premiumIssues state', async () => {
    settingsStoreMock.getEffectiveSourcesByKind = () => [];
    usePremiumStore.setState({ feeds: [{ id: 'p1', kind: 'news' }], enabledIds: ['p1'] });
    getAccessToken.mockResolvedValue('tok-3');
    fetchHeadlinesWithSources.mockResolvedValue({
      headlines: [{ id: 'h1' }],
      fetchedAt: 't1',
      premiumStatus: [
        { id: 'p1', ok: false, reason: 'expired' },
        { id: 'p2', ok: true },
      ],
    });

    await useFeedStore.getState().fetchFeeds();

    expect(useFeedStore.getState().premiumIssues).toEqual([{ id: 'p1', ok: false, reason: 'expired' }]);
  });
});
