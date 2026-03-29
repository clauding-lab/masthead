import { useState, useEffect } from 'react';
import useSettingsStore from '../stores/settingsStore';
import useAuthStore from '../stores/authStore';
import { getStorageEstimate } from '../lib/db';
import SourceToggleRow from '../components/SourceToggleRow';
import AddSourceModal from '../components/AddSourceModal';
import sourcesData from '../../lib/sources.json';

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
      <span className="text-xl">{icon}</span>
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
  const { theme, fontSize, selectedSourceIds, customSources, setTheme, setFontSize, toggleSource, addCustomSource, removeCustomSource } = useSettingsStore();
  const { user, signInWithGoogle, signOut } = useAuthStore();
  const [storage, setStorage] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    getStorageEstimate().then(setStorage);
  }, []);

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const allSources = [...sourcesData.sources, ...customSources];

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

      {/* News Sources */}
      <SettingSection title="News Sources">
        <div>
          {allSources.map((src) => {
            const isCustom = customSources.some((c) => c.id === src.id);
            return (
              <SourceToggleRow
                key={src.id}
                source={src}
                isEnabled={selectedSourceIds.has(src.id)}
                onToggle={toggleSource}
                onRemove={isCustom ? removeCustomSource : undefined}
              />
            );
          })}
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
        </div>
      </SettingSection>

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
    </div>
  );
}
