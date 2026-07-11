import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const consentAwareStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => {
    if (localStorage.getItem('masthead-cookieConsent') === 'true') {
      localStorage.setItem(key, value);
    }
  },
  removeItem: (key) => localStorage.removeItem(key),
};

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        storage: consentAwareStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
