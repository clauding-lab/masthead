import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { addPendingUrl } from '../lib/db';
import { firstHttpUrl } from '../lib/library';

// Web Share Target receiver (spec §5). Stashes the shared URL into the
// existing `pending` IndexedDB store, then hands off to the Saved page —
// App's pending-drain effect performs the actual save once the app is ready.
export default function SavePage() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const shared =
      firstHttpUrl(params.get('url')) ||
      firstHttpUrl(params.get('text')) ||
      firstHttpUrl(params.get('title'));
    (async () => {
      if (shared) await addPendingUrl(shared);
      navigate('/favorites', {
        replace: true,
        state: shared ? { sharedSave: true } : { saveError: 'No link found in the shared content.' },
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <p className="font-ui text-sm" style={{ color: 'var(--text-tertiary)' }}>Saving…</p>
    </div>
  );
}
