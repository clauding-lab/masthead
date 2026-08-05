import { supabase } from './supabase';

const API = '/api/premium-feeds';

export async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

// Exported (Fix round 1, F8): inboxStore.js reuses this generic
// bearer-token fetch helper for /api/inbox-address rather than duplicating
// it — this store isn't premium-specific, `authed` never was either (path
// is a parameter), and premiumApi.test.js already covers its header/error
// contract.
export async function authed(method, path, body) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sign in required');
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

export const listPremiumFeeds = () => authed('GET', API).then((d) => d.feeds || []);
export const addPremiumFeed = (input) => authed('POST', API, input);
export const patchPremiumFeed = (id, patch) => authed('PATCH', API, { id, ...patch });
export const deletePremiumFeed = (id) => authed('DELETE', API, { id });
export const fetchPremiumBody = (feedId, articleId) =>
  authed('GET', `${API}?feed=${encodeURIComponent(feedId)}&article=${encodeURIComponent(articleId)}`)
    .then((d) => d.article);
