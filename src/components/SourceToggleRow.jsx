export default function SourceToggleRow({ source, isEnabled, onToggle, onRemove }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      style={{ borderBottom: '1px solid var(--divider)' }}
    >
      {/* Color badge */}
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center text-white text-xs font-bold shrink-0"
        style={{ backgroundColor: source.color || '#666' }}
      >
        {source.shortName || source.short_name || source.name?.slice(0, 2)}
      </div>

      {/* Name + category */}
      <div className="flex-1 min-w-0">
        <p className="font-ui text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {source.name}
        </p>
        {source.category && (
          <p className="font-ui text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
            {source.category}
          </p>
        )}
      </div>

      {/* Toggle */}
      <button
        onClick={() => onToggle(source.id || source.source_id)}
        className="relative w-11 h-6 rounded-full shrink-0 transition-colors"
        style={{ backgroundColor: isEnabled ? 'var(--accent)' : 'var(--border)' }}
        aria-label={`Toggle ${source.name}`}
      >
        <div
          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
          style={{ transform: isEnabled ? 'translateX(22px)' : 'translateX(2px)' }}
        />
      </button>

      {/* Delete button for custom sources */}
      {onRemove && (
        <button
          onClick={() => onRemove(source.id || source.source_id)}
          className="p-1 shrink-0"
          style={{ color: 'var(--text-tertiary)' }}
          aria-label={`Remove ${source.name}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
