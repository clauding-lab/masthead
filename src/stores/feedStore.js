import { create } from 'zustand';
import { fetchHeadlines, fetchHeadlinesWithSources } from '../lib/api';
import useSettingsStore from './settingsStore';

// One store per feed surface (2D spec §4.2): News and Blogs each keep their
// own headlines, category, and in-flight sequence guard.
export function createFeedStore(selectRequest) {
  let requestSeq = 0;
  return create((set, get) => ({
    headlines: [],
    isLoading: false,
    error: null,
    fetchedAt: null,
    selectedCategory: null,

    setCategory: (category) => {
      set({ selectedCategory: category });
    },

    fetchFeeds: async () => {
      const requestId = ++requestSeq;
      const { selectedCategory } = get();
      set({ isLoading: true, error: null });
      const applyIfLatest = (partial) => {
        if (requestId === requestSeq) set(partial);
      };
      try {
        const settings = useSettingsStore.getState();
        const { sources, category, fallbackToCatalog } = selectRequest(settings, selectedCategory);

        if (sources.length === 0 && !fallbackToCatalog) {
          // Kind-scoped surface with nothing enabled: an empty slice, not
          // the server's default catalog (2D spec §4.3).
          applyIfLatest({ headlines: [], fetchedAt: new Date().toISOString(), isLoading: false });
          return;
        }

        let data;
        if (sources.length > 0) {
          const sourcesPayload = sources.map((s) => ({
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
          data = await fetchHeadlinesWithSources(sourcesPayload, { category });
        } else {
          data = await fetchHeadlines({ category });
        }

        applyIfLatest({
          headlines: data.headlines || [],
          fetchedAt: data.fetchedAt,
          isLoading: false,
        });
      } catch {
        applyIfLatest({ error: 'Could not refresh feeds', isLoading: false });
      }
    },

    refresh: async () => {
      return get().fetchFeeds();
    },
  }));
}

export const selectNewsRequest = (settings, selectedCategory) =>
  selectedCategory === 'social'
    ? { sources: settings.getEffectiveSourcesByKind('social'), category: null, fallbackToCatalog: false }
    : { sources: settings.getEffectiveSourcesByKind('news'), category: selectedCategory, fallbackToCatalog: true };

export const selectBlogsRequest = (settings, selectedCategory) => ({
  sources: settings.getEffectiveSourcesByKind('blog'),
  category: selectedCategory,
  fallbackToCatalog: false,
});

export const useNewsFeedStore = createFeedStore(selectNewsRequest);
export const useBlogsFeedStore = createFeedStore(selectBlogsRequest);

export default useNewsFeedStore;
