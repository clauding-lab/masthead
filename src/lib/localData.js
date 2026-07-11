import { clearAllLocalData } from './db';

const PRESERVED_KEYS = new Set(['masthead-theme', 'masthead-fontSize', 'masthead-cookieConsent']);

export async function clearUserData() {
  await clearAllLocalData();
  for (const key of Object.keys(localStorage)) {
    if ((key.startsWith('masthead-') && !PRESERVED_KEYS.has(key)) || key.startsWith('sb-')) {
      localStorage.removeItem(key);
    }
  }
}
