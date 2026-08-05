import { Link } from 'react-router-dom';
import { timeAgo } from '../lib/utils';

// DMARC failure means the sender header could be spoofed — surfaced as a
// visible marker rather than silently trusted (spec §7.1). auth_results is
// the raw Authentication-Results header text (lib/inboxIngest.js), so a
// plain substring check is the same signal the server itself recorded.
function isUnverifiedSender(authResults) {
  return typeof authResults === 'string' && authResults.includes('dmarc=fail');
}

export default function InboxMessageRow({ message }) {
  const isUnread = message.read_at === null;
  const unverified = isUnverifiedSender(message.auth_results);

  return (
    <Link
      to={`/inbox/message/${message.id}`}
      className="flex gap-3 px-4 py-3 no-underline"
      style={{ borderBottom: '1px solid var(--divider)', color: 'inherit' }}
    >
      <div className="flex-shrink-0 w-4 pt-1.5">
        {isUnread && (
          <span
            role="img"
            aria-label="Unread"
            className="block w-2 h-2 rounded-full"
            style={{ backgroundColor: 'var(--accent)' }}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="font-ui text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {message.from_name || message.from_email}
          </span>
          {unverified && (
            <span
              className="font-ui text-[10px] px-1.5 py-0.5 rounded shrink-0"
              style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-tertiary)' }}
              title="This sender failed DMARC verification"
            >
              Unverified
            </span>
          )}
        </div>
        <p
          className="font-ui text-sm mb-0.5 truncate"
          style={{ color: 'var(--text-primary)', fontWeight: isUnread ? 600 : 400 }}
        >
          {message.subject}
        </p>
        {message.excerpt && (
          <p className="font-ui text-xs line-clamp-1 mb-1" style={{ color: 'var(--text-secondary)' }}>
            {message.excerpt}
          </p>
        )}
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {timeAgo(message.received_at)}
        </span>
      </div>
    </Link>
  );
}
