import { isInboxPermalink } from './inboxPermalink';

const API_BASE = '/api';

export async function fetchHeadlines({ category, source } = {}) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (source) params.set('source', source);

  const qs = params.toString();
  const url = `${API_BASE}/feeds${qs ? `?${qs}` : ''}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch headlines: ${res.status}`);
  return res.json();
}

export async function fetchHeadlinesWithSources(sources, { category, premiumIds, accessToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken && premiumIds?.length) headers.Authorization = `Bearer ${accessToken}`;
  const body = { sources, category };
  if (premiumIds?.length) body.premiumIds = premiumIds;
  const res = await fetch(`${API_BASE}/feeds`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Failed to fetch headlines: ${res.status}`);
  return res.json();
}

export async function discoverRSS(url) {
  const res = await fetch(`${API_BASE}/discover-rss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
  return res.json();
}

// Security review fix round 1, F1: this is the SINGLE funnel both the
// heart-from-favorites path (via library.js#extractQueued) and the
// plain-URL path (articleStore#fetchArticle, reached unguarded from
// ReaderPage's History-shaped entry point — a hearted inbox message read
// once ends up in history with the minted permalink as its url, and
// HistoryCard links to /article/:id with NO fromFavorites, so
// resolveReaderSource's inbox guard never runs) share to reach
// POST /api/extract. Refusing here — before any fetch — closes both
// entry points with one guard instead of duplicating it per call site.
//
// Fix round 2, N1 (comment accuracy): this does NOT close the analogous
// gap for premium records. isInboxPermalink only matches the
// `/inbox/message/<uuid>` path shape — a premium article's URL is the
// publisher's own URL and never matches it, so a premium record reopened
// via History (the same fromFavorites-less path) still reaches this
// function and falls through to a real fetch. That gap pre-exists this fix
// and is tracked separately, not closed here.
export async function extractArticle(articleUrl, sourceId) {
  if (isInboxPermalink(articleUrl)) {
    throw new Error('Inbox messages are not extractable');
  }
  const res = await fetch(`${API_BASE}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: articleUrl, sourceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Extraction failed: ${res.status}`);
  }
  return res.json();
}
