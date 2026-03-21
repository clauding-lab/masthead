import { timeAgo } from '../lib/utils';
import RefreshButton from './RefreshButton';

export default function TopBar({ fetchedAt, isLoading, onRefresh }) {
  return (
    <header className="sticky top-0 z-50 safe-top" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="flex items-center justify-between px-4 py-3">
        <h1
          className="font-display text-2xl font-bold tracking-wide"
          style={{ color: 'var(--accent)' }}
        >
          MASTHEAD
        </h1>
        <div className="flex items-center gap-3">
          {fetchedAt && (
            <span
              className="font-mono text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {timeAgo(fetchedAt)}
            </span>
          )}
          <RefreshButton isLoading={isLoading} onClick={onRefresh} />
        </div>
      </div>
      {isLoading && <div className="refresh-line" />}
    </header>
  );
}
