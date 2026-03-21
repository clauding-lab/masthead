import { useState, useEffect, useCallback } from 'react';
import { getAllHistory, clearHistory } from '../lib/db';
import HistoryCard from '../components/HistoryCard';
import EmptyState from '../components/EmptyState';

function groupByDate(entries) {
  const groups = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  for (const entry of entries) {
    const readDate = new Date(entry.readAt);
    let label;
    if (readDate >= today) {
      label = 'Today';
    } else if (readDate >= yesterday) {
      label = 'Yesterday';
    } else if (readDate >= weekAgo) {
      label = 'This Week';
    } else {
      label = 'Earlier';
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(entry);
  }

  // Return in order
  const ordered = [];
  for (const label of ['Today', 'Yesterday', 'This Week', 'Earlier']) {
    if (groups[label]) {
      ordered.push({ label, entries: groups[label] });
    }
  }
  return ordered;
}

export default function HistoryPage() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    const items = await getAllHistory();
    setHistory(items);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleClear = async () => {
    await clearHistory();
    setHistory([]);
  };

  if (loading) {
    return (
      <div className="py-8 px-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="mb-4">
            <div className="skeleton w-full h-4 rounded mb-1" />
            <div className="skeleton w-3/4 h-4 rounded mb-1" />
            <div className="skeleton w-1/3 h-3 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <EmptyState
        title="No reading history"
        message="Articles you read will appear here."
      />
    );
  }

  const groups = groupByDate(history);

  return (
    <div>
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--divider)' }}
      >
        <div>
          <h1 className="font-display text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            History
          </h1>
          <p className="font-ui text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {history.length} article{history.length !== 1 ? 's' : ''} read
          </p>
        </div>
        <button
          onClick={handleClear}
          className="font-ui text-xs px-3 py-1.5 rounded-full"
          style={{
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
          }}
        >
          Clear All
        </button>
      </div>
      {groups.map((group) => (
        <div key={group.label}>
          <div
            className="px-4 py-2 font-ui text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-tertiary)', backgroundColor: 'var(--bg-surface)' }}
          >
            {group.label}
          </div>
          {group.entries.map((entry) => (
            <HistoryCard key={entry.id + entry.readAt} entry={entry} />
          ))}
        </div>
      ))}
    </div>
  );
}
