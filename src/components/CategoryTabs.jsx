import useSettingsStore from '../stores/settingsStore';

export default function CategoryTabs({ selected, onSelect }) {
  const effectiveSources = useSettingsStore((s) => s.getEffectiveSources());

  // Derive unique categories from active sources
  const seen = new Set();
  const dynamicCategories = [];
  for (const src of effectiveSources) {
    const cat = src.category;
    if (cat && !seen.has(cat)) {
      seen.add(cat);
      dynamicCategories.push({ id: cat, label: cat.charAt(0).toUpperCase() + cat.slice(1) });
    }
  }

  const categories = [{ id: null, label: 'All' }, ...dynamicCategories];

  return (
    <div className="px-4 py-2 overflow-x-auto no-scrollbar" style={{ borderBottom: '1px solid var(--divider)' }}>
      <div className="flex gap-2 min-w-max">
        {categories.map((cat) => {
          const isActive = selected === cat.id;
          return (
            <button
              key={cat.id ?? 'all'}
              onClick={() => onSelect(cat.id)}
              className="px-4 py-1.5 rounded-full text-sm font-ui font-medium whitespace-nowrap transition-colors"
              style={{
                backgroundColor: isActive ? 'var(--accent)' : 'var(--bg-surface)',
                color: isActive ? '#FFFFFF' : 'var(--text-secondary)',
                border: isActive ? 'none' : '1px solid var(--border)',
              }}
            >
              {cat.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
