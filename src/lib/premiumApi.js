import { supabase } from './supabase';

const API = '/api/premium-feeds';

export async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

async function authed(method, path, body) {
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
