import { create } from 'zustand';
import { fetchHeadlinesWithSources } from '../lib/api';
import useSettingsStore from './settingsStore';
import usePremiumStore from './premiumStore';
import { getAccessToken } from '../lib/premiumApi';
import { supabase } from '../lib/supabase';

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
    premiumIssues: [],
    premiumAuthFailed: false,

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
        const { sources, category, fallbackToCatalog, premiumIds = [] } = selectRequest(settings, selectedCategory);

        if (sources.length === 0 && premiumIds.length === 0 && !fallbackToCatalog) {
          // Kind-scoped surface with nothing enabled: an empty slice, not
          // the server's default catalog (2D spec §4.3, amended for premium
          // 2E §5.2 landmine-16: a premium-only surface must still fetch).
          applyIfLatest({ headlines: [], fetchedAt: new Date().toISOString(), isLoading: false });
          return;
        }

        // Past the guard above, sources or premiumIds is non-empty: every
        // surface now resolves to a kind-scoped POST, never the catalog-wide GET.
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

        const accessToken = premiumIds.length > 0 ? await getAccessToken() : null;
        let data = await fetchHeadlinesWithSources(sourcesPayload, { category, premiumIds, accessToken });

        if (data.premiumAuthFailed && supabase) {
          // Spec §4.2: refresh the session and retry exactly once — never silent.
          await supabase.auth.refreshSession();
          const retryToken = await getAccessToken();
          data = await fetchHeadlinesWithSources(sourcesPayload, { category, premiumIds, accessToken: retryToken });
        }

        applyIfLatest({
          headlines: data.headlines || [],
          fetchedAt: data.fetchedAt,
          isLoading: false,
          premiumAuthFailed: !!data.premiumAuthFailed,
          premiumIssues: (data.premiumStatus || []).filter((s) => !s.ok),
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

export const selectNewsRequest = (settings, selectedCategory) => {
  const premium = usePremiumStore.getState();
  return selectedCategory === 'social'
    ? { sources: settings.getEffectiveSourcesByKind('social'), category: null, fallbackToCatalog: false, premiumIds: [] }
    : { sources: settings.getEffectiveSourcesByKind('news'), category: selectedCategory, fallbackToCatalog: false, premiumIds: premium.getEnabledPremiumIdsByKind('news') };
};

export const selectBlogsRequest = (settings, selectedCategory) => ({
  sources: settings.getEffectiveSourcesByKind('blog'),
  category: selectedCategory,
  fallbackToCatalog: false,
  premiumIds: usePremiumStore.getState().getEnabledPremiumIdsByKind('blog'),
});

export const useNewsFeedStore = createFeedStore(selectNewsRequest);
export const useBlogsFeedStore = createFeedStore(selectBlogsRequest);

export default useNewsFeedStore;
