import { sourceKind } from './sourceKind';

function deriveCategories(sources) {
  const seen = new Set();
  const cats = [];
  for (const src of sources) {
    const cat = src.category;
    if (cat && !seen.has(cat)) {
      seen.add(cat);
      cats.push({ id: cat, label: cat.charAt(0).toUpperCase() + cat.slice(1) });
    }
  }
  return cats;
}

const ALL = { id: null, label: 'All' };
// Always visible for discovery; empty state handles zero enabled (2D §4.3).
const SOCIAL = { id: 'social', label: 'Social' };

export function newsTabCategories(activeSources) {
  const news = activeSources.filter((s) => sourceKind(s) === 'news');
  return [ALL, ...deriveCategories(news), SOCIAL];
}

export function blogsTabCategories(activeSources) {
  const blogs = activeSources.filter((s) => sourceKind(s) === 'blog');
  return [ALL, ...deriveCategories(blogs)];
}
