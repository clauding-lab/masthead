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

  setArticle: (article) => {
    set({ article, isLoading: false, error: null });
  },

  clearArticle: () => {
    set({ article: null, isLoading: false, error: null });
  },
}));

export default useArticleStore;
