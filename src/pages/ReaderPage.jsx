import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import useArticleStore from '../stores/articleStore';
import useSettingsStore from '../stores/settingsStore';
import SourceBadge from '../components/SourceBadge';
import FavoriteToggle from '../components/FavoriteToggle';
import EmptyState from '../components/EmptyState';
import { addToHistory, getFavorite } from '../lib/db';
import { formatDate, formatReadingTime } from '../lib/utils';
import useSwipeBack from '../hooks/useSwipeBack';
import '../styles/reader.css';

function ReaderSkeleton() {
  return (
    <div className="max-w-[680px] mx-auto px-5 py-6">
      <div className="skeleton w-16 h-5 rounded mb-4" />
      <div className="skeleton w-full h-8 rounded mb-2" />
      <div className="skeleton w-3/4 h-8 rounded mb-4" />
      <div className="flex gap-3 mb-6">
        <div className="skeleton w-24 h-4 rounded" />
        <div className="skeleton w-20 h-4 rounded" />
      </div>
      <div className="skeleton w-full h-48 rounded-lg mb-6" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton w-full h-4 rounded mb-3" />
      ))}
      <div className="skeleton w-2/3 h-4 rounded mb-3" />
    </div>
  );
}

export default function ReaderPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { article, isLoading, error, fetchArticle, clearArticle, setArticle } = useArticleStore();
  const fontSize = useSettingsStore((s) => s.fontSize);
  const historyRecorded = useRef(false);
  const pageRef = useRef(null);
  useSwipeBack(pageRef);

  const { url, sourceId, sourceName, sourceShortName, sourceColor, fromFavorites } =
    location.state || {};

  useEffect(() => {
    if (fromFavorites && id) {
      // Load from IndexedDB if coming from favorites
      getFavorite(id).then((saved) => {
        if (saved) {
          setArticle(saved);
        } else if (url) {
          fetchArticle(url, sourceId);
        }
      });
    } else if (url) {
      fetchArticle(url, sourceId);
    }
    return () => clearArticle();
  }, [url, id]);

  // Auto-mark as read in history
  useEffect(() => {
    if (article && !historyRecorded.current && url) {
      historyRecorded.current = true;
      addToHistory({
        id: article.id || id,
        title: article.title,
        url,
        sourceId,
        sourceName: sourceName || article.sourceName,
        sourceShortName,
        sourceColor,
        category: article.category,
        thumbnail: article.leadImage,
        isPaywall: false,
      });
    }
  }, [article]);

  if (!url && !fromFavorites) {
    return (
      <EmptyState
        title="Article not found"
        message="Navigate from the feed to read articles."
        action="Go to Feed"
        onAction={() => navigate('/')}
      />
    );
  }

  return (
    <div ref={pageRef} className="min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Reader top bar */}
      <header
        className="sticky top-0 z-40 flex items-center justify-between px-4 py-3"
        style={{ backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--divider)' }}
      >
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 font-ui text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back
        </button>
        <div className="flex items-center gap-1">
          <FavoriteToggle article={article ? { ...article, sourceId, sourceName, sourceShortName, sourceColor } : null} />
          {/* Share button */}
          <button
            onClick={() => {
              if (navigator.share) {
                navigator.share({ title: article?.title, url });
              } else {
                navigator.clipboard.writeText(url);
              }
            }}
            className="p-2"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="Share article"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <polyline points="16 6 12 2 8 6" />
              <line x1="12" y1="2" x2="12" y2="15" />
            </svg>
          </button>
          {/* Open external */}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="Open in browser"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        </div>
      </header>

      {isLoading && <ReaderSkeleton />}

      {error && (
        <EmptyState
          title="Extraction failed"
          message={error}
          action="Try Again"
          onAction={() => fetchArticle(url, sourceId)}
        />
      )}

      {article && !isLoading && (
        <article className="max-w-[680px] mx-auto px-5 py-6">
          {/* Article header */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              {sourceShortName && (
                <SourceBadge shortName={sourceShortName} color={sourceColor} />
              )}
              {(sourceName || article.sourceName) && (
                <span className="font-ui text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {sourceName || article.sourceName}
                </span>
              )}
            </div>
            <h1
              className="font-display text-2xl font-bold leading-tight mb-3"
              style={{ color: 'var(--text-primary)' }}
            >
              {article.title}
            </h1>
            <div className="flex flex-wrap items-center gap-3">
              {article.byline && (
                <span className="font-ui text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {article.byline}
                </span>
              )}
              {article.publishedAt && (
                <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {formatDate(article.publishedAt)}
                </span>
              )}
              <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {formatReadingTime(article.readingTimeMinutes)}
              </span>
            </div>
          </div>

          {/* Lead image */}
          {article.leadImage && (
            <div className="mb-6 -mx-5 sm:mx-0">
              <img
                src={article.leadImage}
                alt=""
                className="w-full sm:rounded-lg"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            </div>
          )}

          {/* Article body */}
          <div
            className="reader-body"
            style={{ fontSize: `${fontSize}px` }}
            dangerouslySetInnerHTML={{ __html: article.content }}
          />
        </article>
      )}
    </div>
  );
}
