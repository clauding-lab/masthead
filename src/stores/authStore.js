import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { syncOnSignIn, pushOnboardingSources } from '../lib/sync';

// Premium feeds are server-owned and start unloaded (final-review Critical
// 1): without this, premiumStore.feeds stays [] on a normal boot to "/" and
// premium articles never appear until a Settings visit happens to trigger
// loadFeeds. This must run on every path that establishes a session —
// restored session AND fresh sign-in — so it's called from both spots in
// initAuth below, never from a subscription (nothing here can re-invoke
// itself, so it cannot loop), and any failure is swallowed: premium
// bootstrapping must never break app boot.
//
// Sequencing: a kind surface's initial fetchFeeds may already have fired
// with premiumIds: [] before loadFeeds resolves (FeedLayout's mount effect
// races the network call). Once loadFeeds is done, refetch any kind whose
// enabled premium set is now non-empty so the premium articles actually
// show up without waiting for the next manual refresh.
async function bootstrapPremiumFeeds() {
  try {
    const usePremiumStore = (await import('./premiumStore')).default;
    await usePremiumStore.getState().loadFeeds();
    const { useNewsFeedStore, useBlogsFeedStore } = await import('./feedStore');
    const kindStores = { news: useNewsFeedStore, blog: useBlogsFeedStore };
    for (const [kind, store] of Object.entries(kindStores)) {
      if (usePremiumStore.getState().getEnabledPremiumIdsByKind(kind).length > 0) {
        store.getState().fetchFeeds();
      }
    }
  } catch (err) {
    console.error('[auth] premium feed bootstrap failed:', err);
  }
}

// Same pattern, same landmine (20), extended to the Inbox surface added in
// Phase 3b: useInboxStore's address + unread count must be populated on
// every session-establishing path, not just when the user happens to visit
// the Inbox tab — otherwise BottomTabBar's unread badge and the tab's own
// "get your address" bootstrap card lag behind reality on a normal boot.
// Fire-and-forget alongside bootstrapPremiumFeeds; inboxStore.bootstrap()
// already swallows its own failures (never breaks app boot on its own), and
// this try/catch is belt-and-braces around the dynamic import itself.
async function bootstrapInboxOnAuth() {
  try {
    const useInboxStore = (await import('./inboxStore')).default;
    await useInboxStore.getState().bootstrap();
  } catch (err) {
    console.error('[auth] inbox bootstrap failed:', err);
  }
}

const useAuthStore = create((set, get) => ({
  user: null,
  session: null,
  isLoading: true,
  isInitialized: false,

  initAuth: async () => {
    if (!supabase) {
      set({ isLoading: false, isInitialized: true });
      return;
    }

    try {
      const { data: { session } } = await supabase.auth.getSession();
      set({
        session,
        user: session?.user ?? null,
        isLoading: false,
        isInitialized: true,
      });
      // Restored session (page reload with an existing sign-in): fire and
      // forget, never block boot on the premium API.
      if (session?.user) {
        bootstrapPremiumFeeds();
        bootstrapInboxOnAuth();
      }
    } catch {
      set({ isLoading: false, isInitialized: true });
    }

    supabase.auth.onAuthStateChange((_event, session) => {
      const prevUser = get().user;
      set({ session, user: session?.user ?? null });
      // Sync on new sign-in
      if (session?.user && !prevUser) {
        syncOnSignIn(session.user.id).catch(console.error);
        bootstrapPremiumFeeds();
        bootstrapInboxOnAuth();
        const pending = localStorage.getItem('masthead-pendingSourceSync');
        if (pending) {
          try {
            const ids = JSON.parse(pending);
            pushOnboardingSources(session.user.id, ids)
              .then(() => localStorage.removeItem('masthead-pendingSourceSync'))
              .catch(console.error);
          } catch {
            localStorage.removeItem('masthead-pendingSourceSync');
          }
        }
      }
    });
  },

  signInWithGoogle: async () => {
    if (!supabase) return { error: 'Supabase not configured' };
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    return { error };
  },

  signOut: async () => {
    if (!supabase) return;
    try {
      await supabase.auth.signOut();
    } finally {
      const { clearUserData } = await import('../lib/localData');
      await clearUserData();
      set({ user: null, session: null });
      const useSettingsStore = (await import('./settingsStore')).default;
      useSettingsStore.getState().initFromStorage();

      const usePremiumStore = (await import('./premiumStore')).default;
      usePremiumStore.getState().reset();
      const useInboxStore = (await import('./inboxStore')).default;
      useInboxStore.getState().reset();
      const { useNewsFeedStore, useBlogsFeedStore } = await import('./feedStore');
      for (const store of [useNewsFeedStore, useBlogsFeedStore]) {
        store.setState({ headlines: [], fetchedAt: null, error: null, premiumIssues: [], premiumAuthFailed: false });
      }
      // The Workbox runtime cache would otherwise hand the masked premium list
      // to the next account on a shared device (2E §5.2 / red-team finding).
      if (typeof caches !== 'undefined') {
        await caches.delete('api-cache').catch(() => {});
      }
    }
  },
}));

export default useAuthStore;
