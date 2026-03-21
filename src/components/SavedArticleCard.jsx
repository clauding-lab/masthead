import { Link } from 'react-router-dom';
import SourceBadge from './SourceBadge';
import { timeAgo } from '../lib/utils';

export default function SavedArticleCard({ article, onRemove }) {
  return (
    <div
      className="flex gap-3 px-4 py-3"
      style={{ borderBottom: '1px solid var(--divider)' }}
    >
      <Link
        to={`/article/${article.id}`}
        state={{
          url: article.url,
          sourceId: article.sourceId,
          sourceName: article.sourceName,
          sourceShortName: article.sourceShortName,
          sourceColor: article.sourceColor,
          fromFavorites: true,
        }}
        className="flex-1 min-w-0 no-underline"
        style={{ color: 'inherit' }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          {article.sourceShortName && (
            <SourceBadge shortName={article.sourceShortName} color={article.sourceColor} />
          )}
          <span
            className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            Saved offline
          </span>
        </div>
        <h2
          className="font-display text-[15px] leading-snug font-semibold mb-1.5 line-clamp-2"
          style={{ color: 'var(--text-primary)' }}
        >
          {article.title}
        </h2>
        {article.excerpt && (
          <p
            className="font-ui text-xs line-clamp-2 mb-1.5"
            style={{ color: 'var(--text-secondary)' }}
          >
            {article.excerpt}
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Saved {timeAgo(article.savedAt)}
          </span>
          {article.readingTimeMinutes && (
            <>
              <span style={{ color: 'var(--text-tertiary)' }}>·</span>
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                {article.readingTimeMinutes} min read
              </span>
            </>
          )}
        </div>
      </Link>
      {onRemove && (
        <button
          onClick={() => onRemove(article.id)}
          className="flex-shrink-0 self-start p-1.5 rounded"
          style={{ color: 'var(--text-tertiary)' }}
          aria-label="Remove from favorites"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
