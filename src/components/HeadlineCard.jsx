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

export default function HeadlineCard({ headline, variant = 'compact', linkOut = false }) {
  const linkState = {
    url: headline.url,
    sourceId: headline.sourceId,
    sourceName: headline.sourceName,
    sourceShortName: headline.sourceShortName,
    sourceColor: headline.sourceColor,
    isPremium: headline.isPremium,
    hasBody: headline.hasBody,
    premiumFeedId: headline.premiumFeedId,
  };
  // Social posts open the original (2D spec §4.6) — reader extraction on
  // bsky/mastodon post pages produces junk, an honest link-out beats it.
  // Premium items always navigate in-app (2E), even in the social chip —
  // the reader knows how to fetch a premium body; a link-out would just
  // hit the paywall.
  const isLinkOut = linkOut && !headline.isPremium;
  const Wrapper = isLinkOut ? 'a' : Link;
  const wrapperProps = isLinkOut
    ? { href: headline.url, target: '_blank', rel: 'noopener noreferrer' }
    : { to: `/article/${headline.id}`, state: linkState };

  if (variant === 'lead') {
    return (
      <Wrapper
        {...wrapperProps}
        className="group block no-underline px-4 pt-4 pb-5"
        style={{ borderBottom: '1px solid var(--divider)', color: 'inherit' }}
      >
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
      className="group px-4 py-3 cursor-pointer transition-colors block no-underline"
      style={{ borderBottom: '1px solid var(--divider)', color: 'inherit' }}
    >
      <Kicker headline={headline} />
      <h2
        className="font-ui leading-snug font-semibold mb-1.5 line-clamp-3 transition-colors text-[var(--text-primary)] group-hover:text-[var(--accent)]"
        style={{ fontSize: 'var(--step-1)' }}
      >
        {headline.title}
      </h2>
      <MetaRow headline={headline} />
    </Wrapper>
  );
}
