import { useState, useEffect } from 'react';
import useSettingsStore from '../stores/settingsStore';
import { getStorageEstimate } from '../lib/db';

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
  const { theme, fontSize, setTheme, setFontSize } = useSettingsStore();
  const [storage, setStorage] = useState(null);

  useEffect(() => {
    getStorageEstimate().then(setStorage);
  }, []);

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
          {/* Preview */}
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
                v1.0.0
              </p>
            </div>
          </div>
          <p className="font-ui text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            A clean, distraction-free news reader. Built as a progressive web app for fast,
            offline-capable reading from curated sources.
          </p>
        </div>
      </SettingSection>
    </div>
  );
}
