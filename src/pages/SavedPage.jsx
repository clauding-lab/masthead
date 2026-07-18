import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { getAllFavorites } from '../lib/db';
import { deleteSaved, retrySave } from '../lib/library';
import SavedArticleCard from '../components/SavedArticleCard';
import PasteSaveBar from '../components/PasteSaveBar';
import EmptyState from '../components/EmptyState';
import Surface from '../components/ui/Surface';
import Icon from '../components/ui/Icon';

export default function SavedPage() {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const location = useLocation();

  const loadFavorites = useCallback(async () => {
    const items = await getAllFavorites();
    setFavorites(items);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  // A share-target save may still be draining when we land here (spec §5).
  useEffect(() => {
    if (location.state?.sharedSave) {
      const t = setTimeout(loadFavorites, 1500);
      return () => clearTimeout(t);
    }
  }, [location.state, loadFavorites]);

  const handleRemove = async (id) => {
    const item = favorites.find((a) => a.id === id);
    await deleteSaved({ id, url: item?.url });
    setFavorites((prev) => prev.filter((a) => a.id !== id));
  };

  const handleRetry = async (id) => {
    await retrySave(id);
    loadFavorites();
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

  return (
    <div>
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
        <h1 className="font-display text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          Saved
        </h1>
        <p className="font-ui text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          {favorites.length} article{favorites.length !== 1 ? 's' : ''} saved
        </p>
      </div>

      <PasteSaveBar onSaved={loadFavorites} />
      {location.state?.saveError && (
        <p className="font-ui text-xs px-4 py-2" style={{ color: 'var(--danger, #B3261E)' }}>
          {location.state.saveError}
        </p>
      )}

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

      {favorites.length === 0 ? (
        <EmptyState
          title="Nothing saved yet"
          message="Paste a link above, share a page to Masthead, or tap the heart on any article."
        />
      ) : filtered.length === 0 ? (
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
            onRetry={handleRetry}
          />
        ))
      )}
    </div>
  );
}
