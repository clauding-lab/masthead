import { useState, useRef } from 'react';
import { discoverRSS } from '../lib/api';
import { suggestKind } from '../lib/suggestKind';
import useAuthStore from '../stores/authStore';
import usePremiumStore from '../stores/premiumStore';
import Icon from './ui/Icon';

export default function AddSourceModal({ onAdd, onClose }) {
  const [url, setUrl] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [feeds, setFeeds] = useState(null);
  const [error, setError] = useState(null);
  const [category, setCategory] = useState('custom');
  const [kind, setKind] = useState('news');
  // suggestKind is only a domain-based default (2D §4.5): once the user has
  // picked a kind themselves, that choice outranks every later suggestion.
  const [kindTouched, setKindTouched] = useState(false);
  const { user } = useAuthStore();
  const [isPremium, setIsPremium] = useState(false);
  const [premiumAdded, setPremiumAdded] = useState(null);
  const [premiumError, setPremiumError] = useState(null);
  // Anti-autofill (2E §5.1): a fresh random name/id per mount so password
  // managers and browser autofill can't correlate this field across visits.
  const premiumFieldName = useRef('url-' + Math.random().toString(36).slice(2)).current;

  const handleSearch = async () => {
    if (!url.trim()) return;
    setIsSearching(true);
    setFeeds(null);
    setError(null);

    try {
      const result = await discoverRSS(url.trim());
      if (result.feeds && result.feeds.length > 0) {
        setFeeds(result.feeds);
        if (!kindTouched) setKind(suggestKind(result.feeds[0].feedUrl || url.trim()));
      } else {
        setError('No RSS Available');
      }
    } catch {
      setError('Failed to search. Please check the URL and try again.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleAdd = (feed) => {
    onAdd({
      name: feed.title || new URL(feed.feedUrl).hostname,
      shortName: (feed.title || '').slice(0, 3).toUpperCase() || 'RSS',
      url: url.startsWith('http') ? url : `https://${url}`,
      feedUrl: feed.feedUrl,
      feedType: 'rss',
      category,
      color: '#666666',
      paywall: false,
      kind,
    });
  };

  // Premium submissions bypass `onAdd` entirely — they go straight through
  // the premium store, which owns server custody of the URL (2E §5.1).
  const handleAddPremium = async () => {
    setPremiumError(null);
    try {
      const row = await usePremiumStore.getState().addFeed({
        url: url.trim(),
        kind,
        category,
      });
      setPremiumAdded(row);
      setUrl('');
    } catch (err) {
      setPremiumError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ backgroundColor: 'var(--bg-primary)', maxHeight: '80vh' }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full" style={{ backgroundColor: 'var(--border)' }} />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3">
          <h2 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            Add New Source
          </h2>
          <button onClick={onClose} className="p-1" style={{ color: 'var(--text-tertiary)' }}>
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="px-5 pb-6 overflow-y-auto" style={{ maxHeight: '60vh' }}>
          {premiumAdded ? (
            <div className="text-center py-6">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3"
                style={{ backgroundColor: 'var(--bg-surface)' }}
              >
                <Icon name="lock" size={22} aria-label="Premium feed added" style={{ color: 'var(--accent)' }} />
              </div>
              <p className="font-ui text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {premiumAdded.label} · {premiumAdded.hostHint}
              </p>
              <button
                onClick={onClose}
                className="mt-4 w-full px-4 py-2.5 rounded-lg font-ui text-sm font-medium"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
              >
                Done
              </button>
            </div>
          ) : (
            <>
          {/* URL Input */}
          {!isPremium && (
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Enter website URL (e.g., reuters.com)"
              className="flex-1 px-3 py-2.5 rounded-lg font-ui text-sm outline-none"
              style={{
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
            />
            <button
              onClick={handleSearch}
              disabled={isSearching || !url.trim()}
              className="px-4 py-2.5 rounded-lg font-ui text-sm font-medium shrink-0"
              style={{
                backgroundColor: 'var(--accent)',
                color: 'var(--accent-contrast)',
                opacity: isSearching || !url.trim() ? 0.5 : 1,
              }}
            >
              {isSearching ? '...' : 'Find'}
            </button>
          </div>
          )}

          {/* Premium subscriber feed: signed out → sign-in prompt, no submit control (2E §5.1) */}
          {isPremium && !user && (
            <div className="mb-4 px-3 py-3 rounded-lg" style={{ backgroundColor: 'var(--bg-surface)' }}>
              <p className="font-ui text-sm" style={{ color: 'var(--text-primary)' }}>
                Sign in from Settings to add a premium subscriber feed.
              </p>
            </div>
          )}

          {/* Premium subscriber feed: signed in → hardened, autofill-resistant input (2E §5.1) */}
          {isPremium && user && (
            <div className="mb-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  autoComplete="off"
                  name={premiumFieldName}
                  id={premiumFieldName}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => { if (!kindTouched) setKind(suggestKind(url)); }}
                  placeholder="Paste your subscriber feed URL (https://…)"
                  className="flex-1 px-3 py-2.5 rounded-lg font-ui text-sm outline-none"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                />
                <button
                  onClick={handleAddPremium}
                  disabled={!url.trim()}
                  className="px-4 py-2.5 rounded-lg font-ui text-sm font-medium shrink-0"
                  style={{
                    backgroundColor: 'var(--accent)',
                    color: 'var(--accent-contrast)',
                    opacity: !url.trim() ? 0.5 : 1,
                  }}
                >
                  Add
                </button>
              </div>
              {premiumError && (
                <p className="font-ui text-xs mt-2" style={{ color: 'var(--accent)' }}>
                  {premiumError}
                </p>
              )}
            </div>
          )}

          {/* Appears in (2D spec §4.5) */}
          <div className="mb-4">
            <label className="font-ui text-xs font-medium mb-1 block" style={{ color: 'var(--text-tertiary)' }}>
              Appears in
            </label>
            <div className="flex gap-2" role="radiogroup" aria-label="Appears in">
              {[['news', 'News feed'], ['blog', 'Blogs & Newsletters']].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  onClick={() => {
                    setKind(value);
                    setKindTouched(true);
                  }}
                  className="flex-1 px-3 py-2 rounded-lg font-ui text-sm font-medium"
                  style={{
                    backgroundColor: kind === value ? 'var(--accent)' : 'var(--bg-surface)',
                    color: kind === value ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Premium subscriber feed (2E §5.1) */}
          <label className="flex items-start gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={isPremium}
              onChange={(e) => {
                // Custody guard (2E §5.1): `url` is shared with the plain
                // discovery input, which has no autoComplete="off" and feeds
                // the unauthenticated discoverRSS() call. Flipping either
                // direction must not leave a premium token sitting there.
                setIsPremium(e.target.checked);
                setUrl('');
                setPremiumError(null);
              }}
              className="mt-0.5"
            />
            <span className="font-ui text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Premium subscriber feed</span>
              {' — '}URL contains your personal token: stored securely, never shown again.
              Treat this link like a password — anyone who has it can read your paid content.
            </span>
          </label>

          {/* Category selector */}
          <div className="mb-4">
            <label className="font-ui text-xs font-medium mb-1 block" style={{ color: 'var(--text-tertiary)' }}>
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 rounded-lg font-ui text-sm"
              style={{
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
            >
              <option value="bangladesh">Bangladesh</option>
              <option value="macro">Macro</option>
              <option value="tech">Tech</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          {!isPremium && (
            <>
              {/* Loading */}
              {isSearching && (
                <div className="text-center py-8">
                  <div className="inline-block w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
                  <p className="font-ui text-sm mt-3" style={{ color: 'var(--text-secondary)' }}>
                    Searching for RSS feeds...
                  </p>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="text-center py-8">
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3"
                    style={{ backgroundColor: 'var(--bg-surface)' }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  </div>
                  <p className="font-ui text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {error}
                  </p>
                </div>
              )}

              {/* Results */}
              {feeds && feeds.length > 0 && (
                <div className="space-y-2">
                  <p className="font-ui text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>
                    {feeds.length} feed{feeds.length > 1 ? 's' : ''} found
                  </p>
                  {feeds.map((feed, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 p-3 rounded-lg"
                      style={{ backgroundColor: 'var(--bg-surface)' }}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-ui text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {feed.title}
                        </p>
                        <p className="font-mono text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
                          {feed.itemCount} articles
                        </p>
                      </div>
                      <button
                        onClick={() => handleAdd(feed)}
                        className="px-3 py-1.5 rounded-lg font-ui text-xs font-medium shrink-0"
                        style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

