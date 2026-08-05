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
import { isFavorited } from '../lib/db';
import { saveInboxMessage, deleteSaved } from '../lib/library';
import { articleId } from '../../lib/articleId.js';
import { inboxPermalink } from '../lib/inboxPermalink';
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
  // F3 (Opus fix round 1): openMessage returning null previously meant ONE
  // thing — render "This message was removed" — but it actually covers TWO
  // different situations: a genuine miss (PGRST116 / resolved-null,
  // deleted_at is handled separately below) and a transient failure
  // (network blip, expired JWT, any other Supabase error). Only the first
  // is terminal; the second must be retryable, or a flaky connection tells
  // the user their mail is permanently gone.
  const [retryableError, setRetryableError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  // Heart button (Task 17, moved from T16 — sequencing fix: saveInboxMessage
  // is born in this task). `saved` mirrors FavoriteToggle.jsx's own
  // favorited/saving pair; the id under which this message would be saved
  // is derived, not stored — the minted permalink (inboxPermalink) run
  // through articleId, same derivation saveInboxMessage itself uses.
  const [saved, setSaved] = useState(false);
  const [savingHeart, setSavingHeart] = useState(false);

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
    setRetryableError(null);
    openMessage(id).then((result) => {
      if (cancelled) return;
      if (!result) {
        // useInboxStore.getState() is a point-in-time snapshot, not a
        // subscription — safe here because this is THIS call's own
        // errorCode, set synchronously by openMessage right before its
        // promise settled, read immediately in the very next microtask.
        const { error: storeError, errorCode } = useInboxStore.getState();
        const genuineMiss = errorCode === 'PGRST116' || errorCode === 'not_found';
        if (!genuineMiss) {
          setMessage(null);
          setRetryableError(storeError || 'Could not load this message.');
          setIsLoading(false);
          return;
        }
      }
      setMessage(result);
      setRetryableError(null);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // retryCount is a deliberate re-run trigger (id doesn't change on
    // retry) — see handleRetry below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, retryCount]);

  const handleRetry = () => setRetryCount((c) => c + 1);

  // Checks saved state once the message id is known — same derivation
  // saveInboxMessage uses (permalink -> articleId), so this always agrees
  // with what actually got written to IndexedDB.
  useEffect(() => {
    let cancelled = false;
    if (!message?.id) {
      setSaved(false);
      return;
    }
    isFavorited(articleId(inboxPermalink(message.id))).then((result) => {
      if (!cancelled) setSaved(result);
    });
    return () => {
      cancelled = true;
    };
  }, [message?.id]);

  // Un-heart goes through the same removeSaved/tombstone path as every
  // other un-heart in the app (deleteSaved, src/lib/library.js) — the
  // minted permalink is an https:// URL, so it passes the url CHECK
  // constraint the DB enforces (Task 17).
  const handleHeart = async () => {
    if (!message || savingHeart) return;
    setSavingHeart(true);
    try {
      if (saved) {
        const url = inboxPermalink(message.id);
        await deleteSaved({ id: articleId(url), url });
        setSaved(false);
      } else {
        await saveInboxMessage(message);
        setSaved(true);
      }
    } catch (err) {
      console.error('Failed to toggle saved state:', err);
    }
    setSavingHeart(false);
  };

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
  // F6 (Opus fix round 1, one-char fix): `blocked` is null whenever
  // `sanitized` is falsy — including '' (sanitizeEmailHtml stripped
  // html_body down to nothing, e.g. a bare <script> tag). `sanitized ==
  // null` is false for '', so this ternary used to reach `blocked.html`
  // with `blocked` still null — a TypeError crash. `blocked?.html` yields
  // undefined in that case, which is falsy and falls through to the
  // text_body/excerpt fallback chain below, same as `sanitized === null`.
  const renderedHtml = sanitized == null ? null : showRemoteImages ? sanitized : blocked?.html;

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
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                type="button"
                onClick={handleHeart}
                disabled={savingHeart}
                className="p-2 transition-transform active:scale-90"
                style={{ color: saved ? 'var(--accent)' : 'var(--text-secondary)' }}
                aria-label={saved ? 'Remove from favorites' : 'Save to favorites'}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill={saved ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                </svg>
              </button>
              <Button variant="icon" onClick={handleDelete} aria-label="Delete message">
                <Icon name="close" />
              </Button>
            </div>
          )}
        </div>
      </header>

      {isLoading && <MessageSkeleton />}

      {!isLoading && retryableError && (
        <EmptyState
          title="Couldn't load this message"
          message={retryableError}
          action="Retry"
          onAction={handleRetry}
        />
      )}

      {!isLoading && !retryableError && (!message || message.deleted_at) && (
        <EmptyState
          title="This message was removed"
          message="This message is no longer available."
          action="Back to Inbox"
          onAction={() => navigate('/inbox')}
        />
      )}

      {!isLoading && !retryableError && message && !message.deleted_at && (
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
