import { useEffect, useRef } from 'react';

// In-app replacement for window.confirm (AGENTS.md landmine 22 —
// window.confirm freezes in-browser automation drives; the only other site
// in this repo, PremiumSourceRow's delete, stays PARKED and is NOT touched
// here). Mirrors AddSourceModal's dialog conventions — backdrop overlay,
// tokens-styled rounded card, backdrop click closes (src/components/
// AddSourceModal.jsx) — plus a real focus trap: the safe (Cancel) control
// gets initial focus, Tab/Shift+Tab cycle between the two buttons only, and
// Escape cancels, so keyboard focus can never slip behind the backdrop
// while a destructive decision is pending.
export default function ConfirmSheet({ open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current?.focus();

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop — click cancels, same convention as AddSourceModal */}
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />

      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-sheet-title"
        aria-describedby="confirm-sheet-message"
        className="relative w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ backgroundColor: 'var(--bg-primary)' }}
      >
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full" style={{ backgroundColor: 'var(--border)' }} />
        </div>

        <div className="px-5 pt-3 pb-5">
          <h2
            id="confirm-sheet-title"
            className="font-display text-lg font-bold mb-2"
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
          </h2>
          <p
            id="confirm-sheet-message"
            className="font-ui text-sm leading-relaxed mb-5"
            style={{ color: 'var(--text-secondary)' }}
          >
            {message}
          </p>

          <div className="flex gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              className="flex-1 px-4 py-2.5 rounded-lg font-ui text-sm font-medium"
              style={{
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              className="flex-1 px-4 py-2.5 rounded-lg font-ui text-sm font-medium"
              style={{
                backgroundColor: danger ? 'var(--error)' : 'var(--accent)',
                color: danger ? '#FFFFFF' : 'var(--accent-contrast)',
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
