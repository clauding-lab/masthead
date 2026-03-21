import { Link } from 'react-router-dom';
import SourceBadge from './SourceBadge';
import PaywallBadge from './PaywallBadge';
import { timeAgo } from '../lib/utils';

export default function HeadlineCard({ headline }) {
  return (
    <Link
      to={`/article/${headline.id}`}
      state={{
        url: headline.url,
        sourceId: headline.sourceId,
        sourceName: headline.sourceName,
        sourceShortName: headline.sourceShortName,
        sourceColor: headline.sourceColor,
      }}
      className="flex gap-3 px-4 py-3 cursor-pointer transition-colors block no-underline"
      style={{ borderBottom: '1px solid var(--divider)', color: 'inherit' }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <SourceBadge shortName={headline.sourceShortName} color={headline.sourceColor} />
          {headline.isPaywall && <PaywallBadge />}
        </div>
        <h2
          className="font-display text-[15px] leading-snug font-semibold mb-1.5 line-clamp-3"
          style={{ color: 'var(--text-primary)' }}
        >
          {headline.title}
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {timeAgo(headline.publishedAt)}
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>·</span>
          <span className="font-ui text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {headline.sourceName}
          </span>
        </div>
      </div>
      {headline.thumbnail && (
        <div className="flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden" style={{ backgroundColor: 'var(--bg-surface)' }}>
          <img
            src={headline.thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              e.target.style.display = 'none';
            }}
          />
        </div>
      )}
    </Link>
  );
}
