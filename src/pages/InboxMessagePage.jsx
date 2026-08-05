import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useInboxStore from '../stores/inboxStore';
import useSettingsStore from '../stores/settingsStore';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Icon from '../components/ui/Icon';
import { formatDate } from '../lib/utils';
import { sanitizeEmailHtml } from '../lib/sanitize';
import { blockRemoteImages } from '../lib/emailImages';
import '../styles/email-content.css';

// `unsubscribe_url` has no scheme restriction at the DB layer (unlike
// web_url, which the DB CHECK constraint pins to https:// — see
// supabase/migrations/20260731_create_inbox.sql) — a newsletter's
// List-Unsubscribe header is legitimately either an https link or a
// mailto: address. The label names the target so the action isn't a blind
// click; a parse failure (a scheme new URL() can't handle) falls back to a
// generic label rather than throwing.
function unsubscribeLabel(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'mailto:') return 'Unsubscribe (mail app)';
    return `Unsubscribe (${parsed.hostname})`;
  } catch {
    return 'Unsubscribe';
  }
}

function MessageSkeleton() {
  return (
    <div className="max-w-[680px] mx-auto px-5 py-6">
      <div className="skeleton w-full h-7 rounded mb-2" />
      <div className="skeleton w-2/3 h-7 rounded mb-4" />
      <div className="flex gap-3 mb-6">
        <div className="skeleton w-24 h-4 rounded" />
        <div className="skeleton w-20 h-4 rounded" />
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton w-full h-4 rounded mb-3" />
      ))}
    </div>
  );
}

export default function InboxMessagePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { openMessage, remove } = useInboxStore();
  const alwaysLoadRemoteImages = useSettingsStore((s) => s.alwaysLoadRemoteImages);

  const [message, setMessage] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [imagesLoaded, setImagesLoaded] = useState(false);

  // openMessage marks the message read (server + local unreadCount
  // decrement) as a side effect of fetching it — see inboxStore.js. The
  // fetched row is kept in LOCAL state here (not the store's `messages`
  // list, which openMessage only patches read_at onto if the id happens to
  // already be present there — a deep-linked message from a permalink
  // never is). setMessage/setIsLoading run inside the .then() callback,
  // never synchronously in the effect body, so this is the same
  // "subscribe to an external async result" shape ReaderPage.jsx already
  // uses cleanly (not the react-hooks/set-state-in-effect pattern that
  // flags a LOCAL setState called directly and synchronously in an effect).
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setImagesLoaded(false);
    openMessage(id).then((result) => {
      if (cancelled) return;
      setMessage(result);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Sanitize once per fetched message, then compute the blocked variant
  // from that ground truth — "loaded" never round-trips through an
  // unblock step, it just renders the untouched `sanitized` string, which
  // is simpler and can't drift from a swap-back bug.
  const sanitized = useMemo(
    () => (message?.html_body ? sanitizeEmailHtml(message.html_body) : null),
    [message]
  );
  const blocked = useMemo(() => (sanitized ? blockRemoteImages(sanitized) : null), [sanitized]);
  const showRemoteImages = alwaysLoadRemoteImages || imagesLoaded;
  const renderedHtml = sanitized == null ? null : showRemoteImages ? sanitized : blocked.html;

  // Optimistic in the store (remove() tombstones locally before the write
  // resolves); the store issues the server write regardless of whether
  // this id is present in its local list, so a deep-linked message with no
  // local row still gets removed. No window.confirm (AGENTS.md landmine
  // 22) — a single-message delete needs no confirmation per the T14/T16
  // spec ruling.
  const handleDelete = async () => {
    await remove(id);
    navigate('/inbox');
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <header
        className="sticky top-0 z-40 safe-top"
        style={{ backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--divider)' }}
      >
        <div className="flex items-center justify-between gap-2 px-2 py-2">
          <Button variant="icon" onClick={() => navigate(-1)} aria-label="Back">
            <Icon name="back" />
          </Button>
          {!isLoading && message && !message.deleted_at && (
            <Button variant="icon" onClick={handleDelete} aria-label="Delete message">
              <Icon name="close" />
            </Button>
          )}
        </div>
      </header>

      {isLoading && <MessageSkeleton />}

      {!isLoading && (!message || message.deleted_at) && (
        <EmptyState
          title="This message was removed"
          message="This message is no longer available."
          action="Back to Inbox"
          onAction={() => navigate('/inbox')}
        />
      )}

      {!isLoading && message && !message.deleted_at && (
        <article className="max-w-[680px] mx-auto px-5 py-6">
          <div className="mb-6">
            <h1
              className="font-display text-2xl font-bold leading-tight mb-3"
              style={{ color: 'var(--text-primary)' }}
            >
              {message.subject}
            </h1>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <span className="font-ui text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {message.from_name || message.from_email}
              </span>
              <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {formatDate(message.received_at)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {message.web_url && (
                <a
                  href={message.web_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-ui text-xs font-medium"
                  style={{ color: 'var(--accent)' }}
                >
                  View original
                </a>
              )}
              {message.unsubscribe_url && (
                <a
                  href={message.unsubscribe_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-ui text-xs font-medium"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {unsubscribeLabel(message.unsubscribe_url)}
                </a>
              )}
            </div>
          </div>

          {renderedHtml ? (
            <>
              {!showRemoteImages && blocked.blockedCount > 0 && (
                <button
                  onClick={() => setImagesLoaded(true)}
                  className="mb-4 px-3 py-1.5 rounded-lg font-ui text-xs font-medium"
                  style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  Load images ({blocked.blockedCount})
                </button>
              )}
              <div className="email-content overflow-x-hidden" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            </>
          ) : message.text_body ? (
            <pre className="whitespace-pre-wrap font-ui text-sm" style={{ color: 'var(--text-primary)' }}>
              {message.text_body}
            </pre>
          ) : (
            <div className="text-center py-8">
              {message.excerpt && (
                <p className="font-ui text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                  {message.excerpt}
                </p>
              )}
              {message.web_url && (
                <a
                  href={message.web_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-4 py-2 rounded-lg font-ui text-sm"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  View original
                </a>
              )}
            </div>
          )}
        </article>
      )}
    </div>
  );
}
