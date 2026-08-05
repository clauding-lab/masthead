import { useState, useEffect } from 'react';
import useSettingsStore from '../stores/settingsStore';
import useAuthStore from '../stores/authStore';
import usePremiumStore from '../stores/premiumStore';
import useInboxStore from '../stores/inboxStore';
import { getStorageEstimate } from '../lib/db';
import SourceToggleRow from '../components/SourceToggleRow';
import PremiumSourceRow from '../components/PremiumSourceRow';
import AddSourceModal from '../components/AddSourceModal';
import ConfirmSheet from '../components/ConfirmSheet';
import Icon from '../components/ui/Icon';
import sourcesData from '../../lib/sources.json';
import { sourceKind } from '../lib/sourceKind';
import { MAX_LIVE_BYTES } from '../../lib/inboxConfig.js';

const BYTES_PER_MB = 1024 * 1024;
const MAX_LIVE_MB = MAX_LIVE_BYTES / BYTES_PER_MB; // 100 — a round number by design (spec's 100 MB cap)

// Confirm-sheet copy for the three ConfirmSheet-gated inbox address actions
// (T18 — spec §4.2 bulk remedy for Clear read). All three are effectively
// irreversible from the user's point of view (mail stops routing, or
// messages are gone for good), so all three render with danger styling.
const INBOX_CONFIRM = {
  regenerate: {
    title: 'Regenerate address?',
    message: 'This permanently stops mail sent to the old address — update your subscriptions after.',
    confirmLabel: 'Regenerate',
  },
  remove: {
    title: 'Remove inbox address?',
    message: "This stops mail sent to your address — you can request a new one anytime. Your existing messages won't be affected.",
    confirmLabel: 'Remove',
  },
  clearRead: {
    title: 'Clear read messages?',
    message: "This permanently deletes every read message in your inbox. This can't be undone.",
    confirmLabel: 'Clear read',
  },
};

function formatQuotaMB(bytes) {
  return (bytes / BYTES_PER_MB).toFixed(1);
}

// Address + Copy button. Local to SettingsPage (mirrors the file's existing
// ThemeOption/SettingSection local-component convention) rather than a new
// shared file — InboxPage.jsx's own CopyableAddress is out of this task's
// file scope (task-18-brief.md lists only ConfirmSheet.jsx + SettingsPage.jsx).
// Same clipboard contract as InboxPage's: swallow a permission denial rather
// than let it surface as an unhandled rejection.
function EmailAddressRow({ address }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard
      .writeText(address)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg mb-3"
      style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <span className="font-mono text-sm flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
        {address}
      </span>
      <button
        onClick={handleCopy}
        className="font-ui text-xs font-medium px-2.5 py-1 rounded-md shrink-0"
        style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

const FONT_SIZES = [
  { value: 14, label: 'Small' },
  { value: 16, label: 'Medium' },
  { value: 18, label: 'Default' },
  { value: 20, label: 'Large' },
  { value: 22, label: 'X-Large' },
];

function ThemeOption({ value, label, icon, current, onSelect }) {
  const active = current === value;
  return (
    <button
      onClick={() => onSelect(value)}
      className="flex flex-col items-center gap-2 flex-1 py-3 rounded-lg transition-all"
      style={{
        backgroundColor: active ? 'var(--accent-soft)' : 'var(--bg-surface)',
        border: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <Icon name={icon} size={20} style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }} />
      <span
        className="font-ui text-xs font-medium"
        style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}
      >
        {label}
      </span>
    </button>
  );
}

function SettingSection({ title, children }) {
  return (
    <div className="mb-6">
      <h2
        className="font-ui text-xs font-semibold uppercase tracking-wider px-4 py-2"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {title}
      </h2>
      <div style={{ backgroundColor: 'var(--bg-card)' }}>
        {children}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const {
    theme, fontSize, selectedSourceIds, customSources, alwaysLoadRemoteImages,
    setTheme, setFontSize, toggleSource, addCustomSource, removeCustomSource, setAlwaysLoadRemoteImages,
  } = useSettingsStore();
  const { user, signInWithGoogle, signOut } = useAuthStore();
  const premiumFeeds = usePremiumStore((s) => s.feeds);
  const {
    address: inboxAddress, bytesUsed, messageCount, deferredCount,
    regenerateAddress, removeAddress, clearRead, refreshQuota,
  } = useInboxStore();
  const [storage, setStorage] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  // Which ConfirmSheet is open, if any: 'regenerate' | 'remove' | 'clearRead' | null.
  const [inboxConfirmAction, setInboxConfirmAction] = useState(null);

  useEffect(() => {
    getStorageEstimate().then(setStorage);
  }, []);

  // Premium feeds are server-owned; only load once a session exists (2E §5.1).
  useEffect(() => {
    if (user) {
      usePremiumStore.getState().loadFeeds();
    }
  }, [user]);

  // Quota freshness (T18, F9 T15 review): bytesUsed/messageCount/deferredCount
  // are only written by bootstrap + the address actions, so they can be
  // stale by the time this section is viewed. A lightweight GET refresh on
  // mount keeps the meter honest; refreshQuota swallows its own errors and
  // is a no-op when signed out.
  useEffect(() => {
    if (user) {
      refreshQuota();
    }
  }, [user, refreshQuota]);

  const handleInboxConfirm = () => {
    const action = inboxConfirmAction;
    setInboxConfirmAction(null);
    if (action === 'regenerate') regenerateAddress();
    else if (action === 'remove') removeAddress();
    else if (action === 'clearRead') clearRead();
  };

  const premiumFeedsByKind = premiumFeeds.reduce((acc, feed) => {
    (acc[feed.kind] ||= []).push(feed);
    return acc;
  }, {});

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const allSources = [...sourcesData.sources, ...customSources];
  const sourceGroups = [
    ['News Sources', allSources.filter((s) => sourceKind(s) === 'news'), 'news'],
    ['Blogs & Newsletters', allSources.filter((s) => sourceKind(s) === 'blog'), 'blog'],
    ['Social', allSources.filter((s) => sourceKind(s) === 'social'), 'social'],
  ];

  const handleAddSource = (source) => {
    addCustomSource(source);
    setShowAddModal(false);
  };

  return (
    <div>
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
        <h1
          className="font-display text-lg font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          Settings
        </h1>
      </div>

      {/* Account */}
      <SettingSection title="Account">
        <div className="px-4 py-3">
          {user ? (
            <div className="flex items-center gap-3">
              {user.user_metadata?.avatar_url && (
                <img
                  src={user.user_metadata.avatar_url}
                  alt=""
                  className="w-10 h-10 rounded-full"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="font-ui text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {user.user_metadata?.full_name || user.email}
                </p>
                <p className="font-ui text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
                  {user.email}
                </p>
              </div>
              <button
                onClick={signOut}
                className="px-3 py-1.5 rounded-lg font-ui text-xs font-medium"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              onClick={signInWithGoogle}
              className="w-full py-2.5 rounded-lg font-ui text-sm font-medium flex items-center justify-center gap-2"
              style={{ backgroundColor: '#fff', color: '#333', border: '1px solid var(--border)' }}
            >
              <svg width="16" height="16" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              Sign in with Google
            </button>
          )}
        </div>
      </SettingSection>

      {/* Sources, grouped by kind */}
      {sourceGroups.map(([title, sources, groupKind], gi) => (
        <SettingSection key={title} title={title}>
          <div>
            {sources.map((src) => {
              const isCustom = customSources.some((c) => c.id === src.id);
              return (
                <SourceToggleRow
                  key={src.id}
                  source={src}
                  isEnabled={selectedSourceIds.includes(src.id)}
                  onToggle={toggleSource}
                  onRemove={isCustom ? removeCustomSource : undefined}
                />
              );
            })}
            {user && premiumFeedsByKind[groupKind]?.map((feed) => (
              <PremiumSourceRow key={feed.id} feed={feed} />
            ))}
            {gi === 0 && (
              <button
                onClick={() => setShowAddModal(true)}
                className="w-full px-4 py-3 flex items-center gap-3 font-ui text-sm font-medium"
                style={{ color: 'var(--accent)' }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="16" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                </svg>
                Add New Source
              </button>
            )}
          </div>
        </SettingSection>
      ))}

      {/* Theme */}
      <SettingSection title="Appearance">
        <div className="px-4 py-3 flex gap-2">
          <ThemeOption value="light" label="Light" icon="sun" current={theme} onSelect={setTheme} />
          <ThemeOption value="dark" label="Dark" icon="moon" current={theme} onSelect={setTheme} />
          <ThemeOption value="system" label="Auto" icon="device" current={theme} onSelect={setTheme} />
        </div>
      </SettingSection>

      {/* Font Size */}
      <SettingSection title="Reader Font Size">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <span className="font-ui text-sm" style={{ color: 'var(--text-primary)' }}>
              {FONT_SIZES.find((f) => f.value === fontSize)?.label || 'Default'}
            </span>
            <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {fontSize}px
            </span>
          </div>
          <input
            type="range"
            min={14}
            max={22}
            step={2}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-full accent-slider"
          />
          <div className="flex justify-between mt-1">
            <span className="font-ui text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Aa</span>
            <span className="font-ui text-base" style={{ color: 'var(--text-tertiary)' }}>Aa</span>
          </div>
          <div
            className="mt-4 p-3 rounded-lg"
            style={{ backgroundColor: 'var(--bg-surface)', fontFamily: 'var(--font-body)', fontSize: `${fontSize}px`, lineHeight: 1.75, color: 'var(--text-primary)' }}
          >
            The quick brown fox jumps over the lazy dog.
          </div>
        </div>
      </SettingSection>

      {/* Inbox — remote images in newsletter bodies are a tracking-pixel /
          read-receipt vector, so InboxMessagePage.jsx blocks them by
          default; this opts back into always loading them automatically. */}
      <SettingSection title="Inbox">
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-ui text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Load images automatically
            </p>
            <p className="font-ui text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              Off by default — newsletter images can be used to track when you open a message.
            </p>
          </div>
          <button
            onClick={() => setAlwaysLoadRemoteImages(!alwaysLoadRemoteImages)}
            className="relative w-11 h-6 rounded-full shrink-0 transition-colors"
            style={{ backgroundColor: alwaysLoadRemoteImages ? 'var(--accent)' : 'var(--border)' }}
            aria-label="Load remote images automatically"
            aria-pressed={alwaysLoadRemoteImages}
          >
            <div
              className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
              style={{ transform: alwaysLoadRemoteImages ? 'translateX(22px)' : 'translateX(2px)' }}
            />
          </button>
        </div>

        {/* Email inbox address management (T18) — server-owned, so gated on
            a session the same way premium feeds are gated above. */}
        {user && (
          <div className="px-4 py-3" style={{ borderTop: '1px solid var(--divider)' }}>
            {inboxAddress && <EmailAddressRow address={inboxAddress} />}
            {/* Final whole-branch review, F1: hoisted out of the
                `inboxAddress ?` branch — removeAddress() is row-preserving,
                so the meter and Clear-read row must survive address removal
                as long as retained messages exist (`messageCount > 0`).
                Regenerate/Remove stay address-gated below — there's no
                address left to act on once it's null. */}
            {(inboxAddress || messageCount > 0) && (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-ui text-sm" style={{ color: 'var(--text-primary)' }}>
                    Inbox storage
                  </span>
                  <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {formatQuotaMB(bytesUsed)} MB of {MAX_LIVE_MB} MB · {messageCount} message{messageCount === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-surface)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min((bytesUsed / MAX_LIVE_BYTES) * 100, 100)}%`,
                      backgroundColor: 'var(--accent)',
                    }}
                  />
                </div>
                {deferredCount > 0 && (
                  <p className="font-ui text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
                    {deferredCount} message{deferredCount === 1 ? '' : 's'} deferred while your inbox was full.
                  </p>
                )}
                <button
                  onClick={() => setInboxConfirmAction('clearRead')}
                  className="mt-3 w-full px-3 py-1.5 rounded-lg font-ui text-xs font-medium"
                  style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  Clear read messages
                </button>
              </>
            )}
            {inboxAddress ? (
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => setInboxConfirmAction('regenerate')}
                  className="flex-1 px-3 py-1.5 rounded-lg font-ui text-xs font-medium"
                  style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  Regenerate address
                </button>
                <button
                  onClick={() => setInboxConfirmAction('remove')}
                  className="flex-1 px-3 py-1.5 rounded-lg font-ui text-xs font-medium"
                  style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--error)', border: '1px solid var(--border)' }}
                >
                  Remove address
                </button>
              </div>
            ) : (
              <p className="font-ui text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Get your inbox address from the Inbox tab.
              </p>
            )}
          </div>
        )}
      </SettingSection>

      {/* Storage */}
      <SettingSection title="Storage">
        <div className="px-4 py-3">
          {storage ? (
            <div className="flex items-center justify-between">
              <span className="font-ui text-sm" style={{ color: 'var(--text-primary)' }}>
                Offline data
              </span>
              <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {formatBytes(storage.usage)} / {formatBytes(storage.quota)}
              </span>
            </div>
          ) : (
            <span className="font-ui text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Storage info unavailable
            </span>
          )}
          {storage && (
            <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-surface)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min((storage.usage / storage.quota) * 100, 100).toFixed(1)}%`,
                  backgroundColor: 'var(--accent)',
                }}
              />
            </div>
          )}
        </div>
      </SettingSection>

      {/* About */}
      <SettingSection title="About">
        <div className="px-4 py-3">
          <div className="flex items-center gap-3 mb-3">
            <img src="/favicon.svg" alt="Masthead" className="w-10 h-10" />
            <div>
              <p className="font-display text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Masthead
              </p>
              <p className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                v2.0.0
              </p>
            </div>
          </div>
          <p className="font-ui text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            A clean, distraction-free news reader. Built as a progressive web app for fast,
            offline-capable reading from curated sources.
          </p>
        </div>
      </SettingSection>

      {showAddModal && (
        <AddSourceModal onAdd={handleAddSource} onClose={() => setShowAddModal(false)} />
      )}

      {inboxConfirmAction && (
        <ConfirmSheet
          open
          title={INBOX_CONFIRM[inboxConfirmAction].title}
          message={INBOX_CONFIRM[inboxConfirmAction].message}
          confirmLabel={INBOX_CONFIRM[inboxConfirmAction].confirmLabel}
          danger
          onConfirm={handleInboxConfirm}
          onCancel={() => setInboxConfirmAction(null)}
        />
      )}
    </div>
  );
}
