import { useState, useEffect, useCallback, useMemo } from 'react';
import { getAllFavorites, removeFavorite } from '../lib/db';
import SavedArticleCard from '../components/SavedArticleCard';
import EmptyState from '../components/EmptyState';

export default function FavoritesPage() {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadFavorites = useCallback(async () => {
    setLoading(true);
    const items = await getAllFavorites();
    setFavorites(items);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  const handleRemove = async (id) => {
    await removeFavorite(id);
    setFavorites((prev) => prev.filter((a) => a.id !== id));
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return favorites;
    const q = search.toLowerCase();
    return favorites.filter(
      (a) =>
        a.title?.toLowerCase().includes(q) ||
        a.excerpt?.toLowerCase().includes(q) ||
        a.sourceName?.toLowerCase().includes(q)
    );
  }, [favorites, search]);

  if (loading) {
    return (
      <div className="py-8 px-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="mb-4">
            <div className="skeleton w-16 h-5 rounded mb-2" />
            <div className="skeleton w-full h-4 rounded mb-1" />
            <div className="skeleton w-3/4 h-4 rounded mb-1" />
            <div className="skeleton w-1/3 h-3 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (favorites.length === 0) {
    return (
      <EmptyState
        title="No saved articles"
        message="Tap the heart icon on any article to save it for offline reading."
      />
    );
  }

  return (
    <div>
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
        <h1 className="font-display text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          Favorites
        </h1>
        <p className="font-ui text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          {favorites.length} article{favorites.length !== 1 ? 's' : ''} saved
        </p>
      </div>

      {/* Search bar */}
      {favorites.length > 1 && (
        <div className="px-4 py-2" style={{ backgroundColor: 'var(--bg-surface)' }}>
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder="Search saved articles..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent outline-none font-ui text-sm"
              style={{ color: 'var(--text-primary)' }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="p-0.5"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="px-4 py-12 text-center">
          <p className="font-ui text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No articles matching "{search}"
          </p>
        </div>
      ) : (
        filtered.map((article) => (
          <SavedArticleCard
            key={article.id}
            article={article}
            onRemove={handleRemove}
          />
        ))
      )}
    </div>
  );
}
