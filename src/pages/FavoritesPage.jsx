import { useState, useEffect, useCallback, useMemo } from 'react';
import { getAllFavorites, removeFavorite } from '../lib/db';
import SavedArticleCard from '../components/SavedArticleCard';
import EmptyState from '../components/EmptyState';
import Surface from '../components/ui/Surface';
import Icon from '../components/ui/Icon';

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
          <Surface className="flex items-center gap-2 px-3 py-2">
            <Icon name="search" size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
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
                <Icon name="close" size={14} />
              </button>
            )}
          </Surface>
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
