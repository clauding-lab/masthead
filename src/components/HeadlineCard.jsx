import { Link } from 'react-router-dom';
import Tag from './ui/Tag';
import PaywallBadge from './PaywallBadge';
import { timeAgo } from '../lib/utils';

function Kicker({ headline }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Tag color={headline.sourceColor} sourceName={headline.sourceShortName} />
      {headline.isPaywall && <PaywallBadge />}
    </div>
  );
}

function MetaRow({ headline }) {
  return (
    <span
      className="font-ui text-[11px]"
      style={{ color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}
    >
      {timeAgo(headline.publishedAt)}
    </span>
  );
}

function Thumbnail({ headline, className }) {
  if (!headline.thumbnail) return null;
  return (
    <div className={className} style={{ backgroundColor: 'var(--bg-surface)' }}>
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
  );
}

export default function HeadlineCard({ headline, variant = 'compact', linkOut = false }) {
  const linkState = {
    url: headline.url,
    sourceId: headline.sourceId,
    sourceName: headline.sourceName,
    sourceShortName: headline.sourceShortName,
    sourceColor: headline.sourceColor,
  };
  // Social posts open the original (2D spec §4.6) — reader extraction on
  // bsky/mastodon post pages produces junk, an honest link-out beats it.
  const Wrapper = linkOut ? 'a' : Link;
  const wrapperProps = linkOut
    ? { href: headline.url, target: '_blank', rel: 'noopener noreferrer' }
    : { to: `/article/${headline.id}`, state: linkState };

  if (variant === 'lead') {
    return (
      <Wrapper
        {...wrapperProps}
        className="group block no-underline px-4 pt-4 pb-5"
        style={{ borderBottom: '1px solid var(--divider)', color: 'inherit' }}
      >
        <Thumbnail
          headline={headline}
          className="w-full aspect-[16/9] rounded-lg overflow-hidden mb-3"
        />
        <Kicker headline={headline} />
        <h2
          className="font-serif font-semibold leading-tight mb-2 line-clamp-4 transition-colors text-[var(--text-primary)] group-hover:text-[var(--accent)]"
          style={{ fontSize: 'var(--step-3)' }}
        >
          {headline.title}
        </h2>
        <MetaRow headline={headline} />
      </Wrapper>
    );
  }

  return (
    <Wrapper
      {...wrapperProps}
      className="group flex gap-3 px-4 py-3 cursor-pointer transition-colors block no-underline"
      style={{ borderBottom: '1px solid var(--divider)', color: 'inherit' }}
    >
      <div className="flex-1 min-w-0">
        <Kicker headline={headline} />
        <h2
          className="font-ui leading-snug font-semibold mb-1.5 line-clamp-3 transition-colors text-[var(--text-primary)] group-hover:text-[var(--accent)]"
          style={{ fontSize: 'var(--step-1)' }}
        >
          {headline.title}
        </h2>
        <MetaRow headline={headline} />
      </div>
      <Thumbnail
        headline={headline}
        className="flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden"
      />
    </Wrapper>
  );
}
