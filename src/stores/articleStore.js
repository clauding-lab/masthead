import { create } from 'zustand';
import { extractArticle } from '../lib/api';

const useArticleStore = create((set) => ({
  article: null,
  isLoading: false,
  error: null,

  fetchArticle: async (url, sourceId) => {
    set({ isLoading: true, error: null, article: null });
    try {
      const article = await extractArticle(url, sourceId);
      set({ article, isLoading: false });
    } catch (err) {
      set({ error: err.message, isLoading: false });
    }
  },

  // Premium: body comes from the feed via the authed endpoint — the
  // extractor would hit the paywall and return a teaser (2E §5.3). Never
  // falls back to extractArticle on failure; the error surfaces as-is.
  fetchPremiumArticle: async (feedId, articleId) => {
    set({ isLoading: true, error: null, article: null });
    try {
      const { fetchPremiumBody } = await import('../lib/premiumApi');
      const body = await fetchPremiumBody(feedId, articleId);
      set({ article: { id: articleId, ...body, isPremium: true }, isLoading: false });
    } catch (err) {
      set({ error: err.message, isLoading: false });
    }
  },

  setArticle: (article) => {
    set({ article, isLoading: false, error: null });
  },

  clearArticle: () => {
    set({ article: null, isLoading: false, error: null });
  },
}));

export default useArticleStore;
