import { useState, useEffect } from 'react';
import { saveFavorite, removeFavorite, isFavorited } from '../lib/db';

export default function FavoriteToggle({ article }) {
  const [favorited, setFavorited] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (article?.id) {
      isFavorited(article.id).then(setFavorited);
    }
  }, [article?.id]);

  const toggle = async () => {
    if (!article || saving) return;
    setSaving(true);
    try {
      if (favorited) {
        await removeFavorite(article.id);
        setFavorited(false);
      } else {
        await saveFavorite(article);
        setFavorited(true);
      }
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
    setSaving(false);
  };

  return (
    <button
      onClick={toggle}
      disabled={!article || saving}
      className="p-2 transition-transform active:scale-90"
      style={{ color: favorited ? 'var(--accent)' : 'var(--text-secondary)' }}
      aria-label={favorited ? 'Remove from favorites' : 'Save to favorites'}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill={favorited ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      </svg>
    </button>
  );
}
