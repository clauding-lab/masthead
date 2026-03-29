import { create } from 'zustand';
import { fetchHeadlines, fetchHeadlinesWithSources } from '../lib/api';
import useSettingsStore from './settingsStore';

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
      const effectiveSources = useSettingsStore.getState().getEffectiveSources();
      let data;

      if (effectiveSources.length > 0) {
        // Map sources to the shape the backend expects
        const sourcesPayload = effectiveSources.map((s) => ({
          id: s.id || s.source_id,
          name: s.name,
          shortName: s.shortName || s.short_name,
          url: s.url,
          feedUrl: s.feedUrl || s.feed_url,
          feedType: s.feedType || s.feed_type || 'rss',
          category: s.category,
          color: s.color,
          paywall: s.paywall || false,
        }));
        data = await fetchHeadlinesWithSources(sourcesPayload, { category: selectedCategory });
      } else {
        data = await fetchHeadlines({ category: selectedCategory });
      }

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
