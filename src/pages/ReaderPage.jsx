import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import useArticleStore from '../stores/articleStore';
import useSettingsStore from '../stores/settingsStore';
import useAuthStore from '../stores/authStore';
import FavoriteToggle from '../components/FavoriteToggle';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Icon from '../components/ui/Icon';
import Tag from '../components/ui/Tag';
import { addToHistory, getFavorite } from '../lib/db';
import { pushHistoryEntry } from '../lib/sync';
import { resolveReaderSource, attachBodyToSaved } from '../lib/library';
import { formatDate, formatReadingTime } from '../lib/utils';
import useSwipeBack from '../hooks/useSwipeBack';
import { sanitizeArticleHtml } from '../lib/sanitize';
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
  const progressBarRef = useRef(null);
  useSwipeBack(pageRef);

  const { url, sourceId, sourceName, sourceShortName, sourceColor, fromFavorites } =
    location.state || {};

  useEffect(() => {
    if (fromFavorites && id) {
      // Saved item: branch on CONTENT-presence, not record-presence — a shell
      // (pending/failed/cloud-pulled) must fall back to live extraction.
      getFavorite(id).then((saved) => {
        const effectiveUrl = saved?.url || url;
        const mode = resolveReaderSource(saved, effectiveUrl);
        if (mode === 'stored') {
          setArticle(saved);
        } else if (mode === 'live') {
          fetchArticle(effectiveUrl, sourceId ?? saved?.sourceId);
        } else if (mode === 'shell') {
          setArticle(saved); // URL-less shell — terminal card below
        } else if (url) {
          fetchArticle(url, sourceId);
        }
      });
    } else if (url) {
      fetchArticle(url, sourceId);
    }
    return () => clearArticle();
  }, [url, id]);

  // A live-fetched body for a saved shell gets attached so the item is
  // offline-readable from then on (extractedAt only exists on live extractions).
  useEffect(() => {
    if (fromFavorites && id && article?.content && article.extractedAt) {
      attachBodyToSaved(id, article).catch(() => {});
    }
  }, [article, fromFavorites, id]);

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
      }).then((entry) => {
        const user = useAuthStore.getState().user;
        if (user) pushHistoryEntry(user.id, entry).catch(() => {});
      });
    }
  }, [article]);

  // Reading-progress bar — compositor-only (transform), reads scroll position only
  useEffect(() => {
    const bar = progressBarRef.current;
    if (!article || !bar) return;
    let ticking = false;
    const updateProgress = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const progress = scrollable > 0 ? Math.min(Math.max(window.scrollY / scrollable, 0), 1) : 0;
      bar.style.transform = `scaleX(${progress})`;
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(updateProgress);
      }
    };
    updateProgress();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [article, isLoading]);

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
        className="sticky top-0 z-40 safe-top"
        style={{ backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--divider)' }}
      >
        <div className="flex items-center justify-between gap-2 px-2 py-2">
          <div className="flex items-center gap-1 min-w-0">
            <Button variant="icon" onClick={() => navigate(-1)} aria-label="Back">
              <Icon name="back" />
            </Button>
            {(sourceShortName || sourceName || article?.sourceName) && (
              <div className="truncate">
                <Tag
                  color={sourceColor}
                  sourceName={sourceShortName || sourceName || article?.sourceName}
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <FavoriteToggle article={article ? { ...article, sourceId, sourceName, sourceShortName, sourceColor } : null} />
            {/* Share button */}
            <Button
              variant="icon"
              onClick={() => {
                if (navigator.share) {
                  navigator.share({ title: article?.title, url });
                } else {
                  navigator.clipboard.writeText(url);
                }
              }}
              aria-label="Share article"
            >
              <Icon name="share" />
            </Button>
            <Button
              as="a"
              variant="icon"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in browser"
            >
              <Icon name="external" />
            </Button>
          </div>
        </div>
        {article && !isLoading && (
          <div className="reader-progress-track">
            <div ref={progressBarRef} className="reader-progress-bar" />
          </div>
        )}
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
          {article.content ? (
            <div
              className="reader-body"
              style={{ fontSize: `${fontSize}px` }}
              dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(article.content) }}
            />
          ) : article.textContent ? (
            <div className="reader-body" style={{ fontSize: `${fontSize}px` }}>
              {article.textContent.split(/\n\n+/).filter((p) => p.trim()).map((p, i) => (
                <p key={i}>{p.trim()}</p>
              ))}
            </div>
          ) : (
            <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
              <p className="font-ui text-sm">Could not extract article content.</p>
              {(article.url || url) && (
                <a
                  href={article.url || url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-3 px-4 py-2 rounded-lg font-ui text-sm"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  Read on original site
                </a>
              )}
            </div>
          )}
        </article>
      )}
    </div>
  );
}
