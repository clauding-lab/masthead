export default function CategoryTabs({ categories, selected, onSelect }) {
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
