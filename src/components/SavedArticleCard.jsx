import { Link } from 'react-router-dom';
import Tag from './ui/Tag';
import Icon from './ui/Icon';
import { timeAgo } from '../lib/utils';
import { isInboxRecord } from '../lib/library';

export default function SavedArticleCard({ article, onRemove, onRetry }) {
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
            <Tag color={article.sourceColor} sourceName={article.sourceShortName} />
          )}
          {article.content ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              Saved offline
            </span>
          ) : article.pendingBody ? (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-tertiary)' }}>
              Fetching…
            </span>
          ) : article.bodyFailed && !isInboxRecord(article) ? (
            // A body-less inbox record is a permanent shell — retrySave
            // refuses to extract it (extractor-ban seam guard, library.js),
            // so a retry button here would be a forever-no-op (fix round 1,
            // F2).
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); onRetry?.(article.id); }}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--danger, #B3261E)' }}
            >
              Couldn't fetch — retry
            </button>
          ) : null}
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
          aria-label="Remove from saved"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}
