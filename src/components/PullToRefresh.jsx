import { useState, useRef, useCallback } from 'react';

const THRESHOLD = 60;

export default function PullToRefresh({ onRefresh, children }) {
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const containerRef = useRef(null);

  const handleTouchStart = useCallback((e) => {
    if (window.scrollY === 0) {
      startY.current = e.touches[0].clientY;
      setPulling(true);
    }
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (!pulling) return;
    const diff = e.touches[0].clientY - startY.current;
    if (diff > 0) {
      setPullDistance(Math.min(diff * 0.4, THRESHOLD * 1.5));
    }
  }, [pulling]);

  const handleTouchEnd = useCallback(async () => {
    if (pullDistance >= THRESHOLD && onRefresh) {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }
    setPulling(false);
    setPullDistance(0);
  }, [pullDistance, onRefresh]);

  const progress = Math.min(pullDistance / THRESHOLD, 1);

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull indicator */}
      <div
        className="overflow-hidden transition-all duration-200 flex items-center justify-center"
        style={{
          height: refreshing ? 40 : pullDistance > 5 ? pullDistance : 0,
        }}
      >
        {refreshing ? (
          <div
            className="w-5 h-5 border-2 rounded-full animate-spin"
            style={{
              borderColor: 'var(--border)',
              borderTopColor: 'var(--accent)',
            }}
          />
        ) : pullDistance > 5 ? (
          <div className="flex flex-col items-center gap-1">
            <div
              className="h-0.5 rounded-full transition-all"
              style={{
                width: `${progress * 80}px`,
                backgroundColor: 'var(--accent)',
                opacity: progress,
              }}
            />
            <span
              className="font-ui text-[10px]"
              style={{ color: 'var(--text-tertiary)', opacity: progress }}
            >
              {progress >= 1 ? 'Release to refresh' : 'Pull to refresh'}
            </span>
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
