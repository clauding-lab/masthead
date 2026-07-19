// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/premiumApi', () => ({
  fetchPremiumBody: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  extractArticle: vi.fn(),
}));

import { fetchPremiumBody } from '../lib/premiumApi';
import { extractArticle } from '../lib/api';
import useArticleStore from './articleStore';

const BODY = { title: 'T', url: 'https://x.example/a', content: '<p>body</p>' };

beforeEach(() => {
  useArticleStore.setState({ article: null, isLoading: false, error: null });
  fetchPremiumBody.mockReset();
  extractArticle.mockReset();
});

describe('fetchPremiumArticle', () => {
  it('success sets article.content (isPremium: true) and isLoading: false', async () => {
    fetchPremiumBody.mockResolvedValue(BODY);
    await useArticleStore.getState().fetchPremiumArticle('feed1', 'art1');
    const state = useArticleStore.getState();
    expect(state.isLoading).toBe(false);
    expect(state.article).toEqual({ id: 'art1', title: 'T', url: 'https://x.example/a', content: '<p>body</p>', isPremium: true });
    expect(state.error).toBeNull();
    expect(fetchPremiumBody).toHaveBeenCalledWith('feed1', 'art1');
  });

  it('rejection sets error and isLoading: false, and never calls extractArticle', async () => {
    fetchPremiumBody.mockRejectedValue(new Error('Sign in required'));
    await useArticleStore.getState().fetchPremiumArticle('feed1', 'art1');
    const state = useArticleStore.getState();
    expect(state.error).toBe('Sign in required');
    expect(state.isLoading).toBe(false);
    expect(state.article).toBeNull();
    expect(extractArticle).not.toHaveBeenCalled();
  });
});
