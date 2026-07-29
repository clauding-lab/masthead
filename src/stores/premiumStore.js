import { create } from 'zustand';
import * as premiumApi from '../lib/premiumApi';

const ENABLED_KEY = 'masthead-premiumEnabled';
const SEEN_KEY = 'masthead-premiumSeen';

function loadIds(key) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function persist(key, ids) {
  localStorage.setItem(key, JSON.stringify(ids));
}

const usePremiumStore = create((set, get) => ({
  feeds: [],
  enabledIds: loadIds(ENABLED_KEY),

  // Reconciliation (spec §5.2, landmine-17 pattern): server truth wins for
  // existence; never-seen server ids default to enabled — a feed the user
  // paid to set up must not be invisible on a new device.
  loadFeeds: async () => {
    const feeds = await premiumApi.listPremiumFeeds();
    const serverIds = new Set(feeds.map((f) => f.id));
    const seen = new Set(loadIds(SEEN_KEY));
    const kept = get().enabledIds.filter((id) => serverIds.has(id));
    const autoEnabled = feeds.filter((f) => !seen.has(f.id) && !kept.includes(f.id)).map((f) => f.id);
    const enabledIds = [...kept, ...autoEnabled];
    persist(ENABLED_KEY, enabledIds);
    persist(SEEN_KEY, [...new Set([...seen, ...serverIds])]);
    set({ feeds, enabledIds });
  },

  addFeed: async (input) => {
    const row = await premiumApi.addPremiumFeed(input);
    set((state) => {
      const enabledIds = [...state.enabledIds, row.id];
      persist(ENABLED_KEY, enabledIds);
      persist(SEEN_KEY, [...new Set([...loadIds(SEEN_KEY), row.id])]);
      return { feeds: [...state.feeds, row], enabledIds };
    });
    return row;
  },

  patchFeed: async (id, patch) => {
    const row = await premiumApi.patchPremiumFeed(id, patch);
    set((state) => ({ feeds: state.feeds.map((f) => (f.id === id ? row : f)) }));
    return row;
  },

  removeFeed: async (id) => {
    await premiumApi.deletePremiumFeed(id);
    set((state) => {
      const enabledIds = state.enabledIds.filter((x) => x !== id);
      persist(ENABLED_KEY, enabledIds);
      return { feeds: state.feeds.filter((f) => f.id !== id), enabledIds };
    });
  },

  toggleEnabled: (id) => {
    set((state) => {
      const enabledIds = state.enabledIds.includes(id)
        ? state.enabledIds.filter((x) => x !== id)
        : [...state.enabledIds, id];
      persist(ENABLED_KEY, enabledIds);
      return { enabledIds };
    });
  },

  getEnabledPremiumIdsByKind: (kind) => {
    const { feeds, enabledIds } = get();
    const enabled = new Set(enabledIds);
    return feeds.filter((f) => f.kind === kind && enabled.has(f.id)).map((f) => f.id);
  },

  reset: () => {
    localStorage.removeItem(ENABLED_KEY);
    localStorage.removeItem(SEEN_KEY);
    set({ feeds: [], enabledIds: [] });
  },
}));

export default usePremiumStore;
