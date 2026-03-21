import { create } from 'zustand';
import { fetchHeadlines } from '../lib/api';

const useFeedStore = create((set, get) => ({
  headlines: [],
  isLoading: false,
  error: null,
  fetchedAt: null,
  selectedCategory: null,

  setCategory: (category) => {
    set({ selectedCategory: category });
  },

  fetchFeeds: async () => {
    const { selectedCategory } = get();
    set({ isLoading: true, error: null });
    try {
      const data = await fetchHeadlines({
        category: selectedCategory,
      });
      set({
        headlines: data.headlines || [],
        fetchedAt: data.fetchedAt,
        isLoading: false,
      });
    } catch (err) {
      set({ error: err.message, isLoading: false });
    }
  },

  refresh: async () => {
    return get().fetchFeeds();
  },
}));

export default useFeedStore;
