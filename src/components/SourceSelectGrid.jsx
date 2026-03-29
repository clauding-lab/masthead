export default function SourceSelectGrid({ sources, selectedIds, onToggle, minRequired = 1 }) {
  // Group by category
  const grouped = {};
  for (const src of sources) {
    const cat = src.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(src);
  }

  const categoryLabels = {
    bangladesh: 'Bangladesh',
    macro: 'Macro',
    tech: 'Tech',
    custom: 'Custom',
    other: 'Other',
  };

  const canDeselect = selectedIds.size > minRequired;

  return (
    <div className="space-y-5">
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat}>
          <h3
            className="font-ui text-xs font-semibold uppercase tracking-wider mb-2 px-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {categoryLabels[cat] || cat}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {items.map((src) => {
              const isSelected = selectedIds.has(src.id);
              const disabled = isSelected && !canDeselect;
              return (
                <button
                  key={src.id}
                  onClick={() => !disabled && onToggle(src.id)}
                  disabled={disabled}
                  className="flex items-center gap-3 p-3 rounded-lg text-left transition-all"
                  style={{
                    backgroundColor: isSelected ? 'var(--accent-soft)' : 'var(--bg-surface)',
                    border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  <div
                    className="w-8 h-8 rounded-md flex items-center justify-center text-white text-xs font-bold shrink-0"
                    style={{ backgroundColor: src.color }}
                  >
                    {src.shortName || src.name.slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <p
                      className="font-ui text-sm font-medium truncate"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {src.name}
                    </p>
                  </div>
                  {/* Checkbox indicator */}
                  <div className="ml-auto shrink-0">
                    {isSelected ? (
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="var(--accent)">
                        <rect width="20" height="20" rx="4" />
                        <path d="M6 10l3 3 5-6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--border)" strokeWidth="2">
                        <rect x="1" y="1" width="18" height="18" rx="4" />
                      </svg>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
