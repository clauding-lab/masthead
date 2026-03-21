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

export async function extractArticle(articleUrl, sourceId) {
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
