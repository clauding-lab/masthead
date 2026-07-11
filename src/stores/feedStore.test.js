// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api', () => ({
  fetchHeadlines: vi.fn(),
  fetchHeadlinesWithSources: vi.fn(),
}));
vi.mock('./settingsStore', () => ({
  default: { getState: () => ({ getEffectiveSources: () => [] }) },
}));

import { fetchHeadlines } from '../lib/api';
import useFeedStore from './feedStore';

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
