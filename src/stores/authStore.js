import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { syncOnSignIn, pushOnboardingSources } from '../lib/sync';

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
    } catch {
      set({ isLoading: false, isInitialized: true });
    }

    supabase.auth.onAuthStateChange((_event, session) => {
      const prevUser = get().user;
      set({ session, user: session?.user ?? null });
      // Sync on new sign-in
      if (session?.user && !prevUser) {
        syncOnSignIn(session.user.id).catch(console.error);
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
    }
  },
}));

export default useAuthStore;
