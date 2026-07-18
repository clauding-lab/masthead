import { useState } from 'react';
import Surface from './ui/Surface';
import Icon from './ui/Icon';
import { saveArticle, firstHttpUrl, LibrarySaveError } from '../lib/library';

export default function PasteSaveBar({ onSaved }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const url = firstHttpUrl(value);
    if (!url) {
      setError('No link found — paste a full article URL.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveArticle({ url, savedVia: 'url' });
      setValue('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof LibrarySaveError ? err.message : 'Could not save that link.');
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="px-4 py-2" style={{ backgroundColor: 'var(--bg-surface)' }}>
      <Surface className="flex items-center gap-2 px-3 py-2">
        <Icon name="bookmark" size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          type="text"
          inputMode="url"
          placeholder="Paste a link to save it…"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          className="flex-1 bg-transparent outline-none font-ui text-sm"
          style={{ color: 'var(--text-primary)' }}
          aria-label="Paste a link to save"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="font-ui text-sm px-2 py-1 rounded"
          style={{ color: 'var(--accent)', opacity: busy || !value.trim() ? 0.5 : 1 }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </Surface>
      {error && (
        <p className="font-ui text-xs mt-1.5 px-1" style={{ color: 'var(--danger, #B3261E)' }}>{error}</p>
      )}
    </form>
  );
}
