import { useMemo } from 'react';
import useSettingsStore from '../stores/settingsStore';
import sourcesData from '../../lib/sources.json';

export default function CategoryTabs({ selected, onSelect }) {
  const selectedSourceIds = useSettingsStore((s) => s.selectedSourceIds);
  const customSources = useSettingsStore((s) => s.customSources);

  const categories = useMemo(() => {
    // Combine default + custom sources, filter to enabled ones
    const allSources = [...sourcesData.sources, ...customSources];
    const idSet = new Set(selectedSourceIds);
    const active = allSources.filter((s) => idSet.has(s.id));

    const seen = new Set();
    const cats = [];
    for (const src of active) {
      const cat = src.category;
      if (cat && !seen.has(cat)) {
        seen.add(cat);
        cats.push({ id: cat, label: cat.charAt(0).toUpperCase() + cat.slice(1) });
      }
    }
    return [{ id: null, label: 'All' }, ...cats];
  }, [selectedSourceIds, customSources]);

  return (
    <div
      className="px-4 overflow-x-auto no-scrollbar"
      style={{ backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--divider)' }}
    >
      <div className="flex gap-5 min-w-max">
        {categories.map((cat) => {
          const isActive = selected === cat.id;
          return (
            <button
              key={cat.id ?? 'all'}
              onClick={() => onSelect(cat.id)}
              className="pt-2.5 pb-2 text-sm font-ui font-medium whitespace-nowrap transition-colors"
              style={{
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
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
