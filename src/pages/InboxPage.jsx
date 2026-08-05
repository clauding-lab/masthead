import { useEffect, useState } from 'react';
import useInboxStore from '../stores/inboxStore';
import useAuthStore from '../stores/authStore';
import PullToRefresh from '../components/PullToRefresh';
import EmptyState from '../components/EmptyState';
import InboxMessageRow from '../components/InboxMessageRow';
import { formatDate } from '../lib/utils';
import { MAX_LIVE_BYTES, MAX_LIVE_MESSAGES } from '../../lib/inboxConfig.js';

// Same ratio for both quota dimensions (spec §7.1's "≥80% quota" banner) —
// a single named constant avoids the value drifting between the two checks.
const QUOTA_WARNING_RATIO = 0.8;

function QuotaBanner({ text }) {
  return (
    <div
      role="status"
      className="mx-4 my-2 px-3 py-2 rounded-lg font-ui text-xs"
      style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
    >
      {text}
    </div>
  );
}

function CopyableAddress({ address }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // navigator.clipboard is undefined in some embedded/older webviews —
    // guard rather than throw; the address text is still visible to copy
    // by hand either way.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(address);
    }
    setCopied(true);
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg"
      style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <span className="font-mono text-sm flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
        {address}
      </span>
      <button
        onClick={handleCopy}
        className="font-ui text-xs font-medium px-2.5 py-1 rounded-md shrink-0 transition-opacity hover:opacity-90"
        style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// Address present, no mail yet — onboarding hint pointing at the address
// the user just got (spec §7.1's "address + empty list" state).
function OnboardingHint({ address }) {
  return (
    <div className="px-4 pt-8 pb-4 text-center">
      <h3 className="font-display text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Your inbox is ready
      </h3>
      <p className="font-ui text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
        Subscribe to a newsletter with the address below — new mail shows up here.
      </p>
      <CopyableAddress address={address} />
    </div>
  );
}

// Quota + deferred-mail banners (spec §7.1). At most two of the three ever
// fire together: overQuotaSince already carries deferredCount in its own
// text, so the plain "deferred note" only fires once quota has cleared but
// a leftover deferredCount is still on the row; the near-quota banner is
// gated off overQuotaSince so it never doubles up with the full-inbox one.
function QuotaBanners({ bytesUsed, messageCount, overQuotaSince, deferredCount }) {
  const bytesRatio = bytesUsed / MAX_LIVE_BYTES;
  const countRatio = messageCount / MAX_LIVE_MESSAGES;
  const nearQuota = !overQuotaSince && (bytesRatio >= QUOTA_WARNING_RATIO || countRatio >= QUOTA_WARNING_RATIO);

  return (
    <>
      {overQuotaSince && (
        <QuotaBanner text={`Inbox full — ${deferredCount} deferred since ${formatDate(overQuotaSince)}`} />
      )}
      {!overQuotaSince && deferredCount > 0 && (
        <QuotaBanner text={`${deferredCount} message${deferredCount === 1 ? '' : 's'} deferred while your inbox was full.`} />
      )}
      {nearQuota && <QuotaBanner text="Your inbox is over 80% full." />}
    </>
  );
}

export default function InboxPage() {
  const { user, signInWithGoogle } = useAuthStore();
  const {
    address, bytesUsed, messageCount, overQuotaSince, deferredCount,
    messages, error, fetchList, requestAddress,
  } = useInboxStore();

  // fetchList on mount + on window focus (fetchList also refreshes
  // unreadCount server-side, so the tab badge stays honest without a
  // separate count call — inboxStore.js's fetchList comment). Gated on
  // having both a session and an address: nothing to list otherwise, and
  // this mirrors the "Get your address" / sign-in branches below never
  // reaching the list UI at all.
  useEffect(() => {
    if (!user || !address) return undefined;
    fetchList();
    const onFocus = () => fetchList();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user, address, fetchList]);

  if (!user) {
    return (
      <EmptyState
        title="Sign in to see your inbox"
        message="Newsletters sent to your Masthead address show up here."
        action="Sign in with Google"
        onAction={signInWithGoogle}
      />
    );
  }

  // Covers both the addressLoaded:true/no-address state AND the
  // addressLoaded:false gap (never-ran / in-flight / ran-and-failed all
  // collapse to false — binding ruling, T15 brief). Either way there's no
  // address to show yet, and the recovery action is the same: let the user
  // request one. This deliberately does NOT key off addressLoaded — doing
  // so would either need a spinner that spins forever on a failed boot GET,
  // or duplicate this exact UI a second time for the false case.
  if (!address) {
    return (
      <>
        {error && <QuotaBanner text={error} />}
        <EmptyState
          title="Get your inbox address"
          message="Subscribe to newsletters with a private address that forwards straight into Masthead."
          action="Get your address"
          onAction={requestAddress}
        />
      </>
    );
  }

  return (
    <div>
      {error && <QuotaBanner text={error} />}
      <QuotaBanners
        bytesUsed={bytesUsed}
        messageCount={messageCount}
        overQuotaSince={overQuotaSince}
        deferredCount={deferredCount}
      />
      {messages.length === 0 ? (
        <OnboardingHint address={address} />
      ) : (
        <PullToRefresh onRefresh={fetchList}>
          <div className="pb-2">
            {messages.map((m) => (
              <InboxMessageRow key={m.id} message={m} />
            ))}
          </div>
        </PullToRefresh>
      )}
    </div>
  );
}
