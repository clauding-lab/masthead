import { useState } from 'react';
import usePremiumStore from '../stores/premiumStore';
import Icon from './ui/Icon';

const CATEGORIES = ['bangladesh', 'macro', 'tech', 'custom'];

export default function PremiumSourceRow({ feed }) {
  const { enabledIds, toggleEnabled, removeFeed, patchFeed } = usePremiumStore();
  const [isEditing, setIsEditing] = useState(false);
  const [label, setLabel] = useState(feed.label);
  const [kind, setKind] = useState(feed.kind);
  const [category, setCategory] = useState(feed.category);
  const isEnabled = enabledIds.includes(feed.id);

  const handleSave = async () => {
    await patchFeed(feed.id, { label, kind, category });
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (window.confirm(`Remove ${feed.label}? You'll need the URL from your subscription page to re-add it.`)) {
      await removeFeed(feed.id);
    }
  };

  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="flex items-center gap-3">
        <Icon name="lock" size={14} aria-label="Premium feed" style={{ color: 'var(--accent)' }} />
        <div className="flex-1 min-w-0">
          <p className="font-ui text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {feed.label}
          </p>
          <p className="font-mono text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
            {feed.hostHint}
          </p>
        </div>
        <button onClick={() => setIsEditing((v) => !v)} className="p-1" aria-label={`Edit ${feed.label}`} style={{ color: 'var(--text-tertiary)' }}>
          <Icon name="edit" size={16} />
        </button>
        <button onClick={handleDelete} className="p-1" aria-label={`Remove ${feed.label}`} style={{ color: 'var(--text-tertiary)' }}>
          <Icon name="close" size={16} />
        </button>
        <button
          role="switch"
          aria-checked={isEnabled}
          aria-label={`Toggle ${feed.label}`}
          onClick={() => toggleEnabled(feed.id)}
          className="w-10 h-6 rounded-full relative shrink-0"
          style={{ backgroundColor: isEnabled ? 'var(--accent)' : 'var(--border)' }}
        >
          <span
            className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
            style={{ transform: isEnabled ? 'translateX(18px)' : 'translateX(2px)' }}
          />
        </button>
      </div>
      {isEditing && (
        <div className="mt-3 space-y-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Feed label"
            className="w-full px-3 py-2 rounded-lg font-ui text-sm"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          />
          <div className="flex gap-2" role="radiogroup" aria-label="Appears in">
            {[['news', 'News'], ['blog', 'Blogs']].map(([value, text]) => (
              <button
                key={value}
                role="radio"
                aria-checked={kind === value}
                onClick={() => setKind(value)}
                className="flex-1 px-3 py-1.5 rounded-lg font-ui text-xs font-medium"
                style={{
                  backgroundColor: kind === value ? 'var(--accent)' : 'var(--bg-surface)',
                  color: kind === value ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                {text}
              </button>
            ))}
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Category"
            className="w-full px-3 py-2 rounded-lg font-ui text-sm"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            onClick={handleSave}
            className="w-full px-3 py-2 rounded-lg font-ui text-sm font-medium"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
