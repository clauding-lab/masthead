import { Link } from 'react-router-dom';
import SourceBadge from './SourceBadge';
import { timeAgo } from '../lib/utils';

export default function HistoryCard({ entry }) {
  return (
    <Link
      to={`/article/${entry.id}`}
      state={{
        url: entry.url,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        sourceShortName: entry.sourceShortName,
        sourceColor: entry.sourceColor,
      }}
      className="flex gap-3 px-4 py-3 no-underline"
      style={{ borderBottom: '1px solid var(--divider)', color: 'inherit' }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          {entry.sourceShortName && (
            <SourceBadge shortName={entry.sourceShortName} color={entry.sourceColor} />
          )}
        </div>
        <h2
          className="font-display text-[15px] leading-snug font-semibold mb-1.5 line-clamp-2"
          style={{ color: 'var(--text-primary)' }}
        >
          {entry.title}
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {timeAgo(entry.readAt)}
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>·</span>
          <span className="font-ui text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {entry.sourceName}
          </span>
        </div>
      </div>
      {entry.thumbnail && (
        <div
          className="flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden"
          style={{ backgroundColor: 'var(--bg-surface)' }}
        >
          <img
            src={entry.thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        </div>
      )}
    </Link>
  );
}
