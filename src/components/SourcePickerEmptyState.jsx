import sourcesData from '../../lib/sources.json';
import useSettingsStore from '../stores/settingsStore';
import { sourceKind } from '../lib/sourceKind';
import SourceToggleRow from './SourceToggleRow';

// One-tap curated picker shown when a kind-scoped surface has no enabled
// sources (2D spec §4.4). Enabling any source swaps this for the feed.
export default function SourcePickerEmptyState({ kind, title, message }) {
  const selectedSourceIds = useSettingsStore((s) => s.selectedSourceIds);
  const toggleSource = useSettingsStore((s) => s.toggleSource);
  const catalog = sourcesData.sources.filter((s) => sourceKind(s) === kind);

  return (
    <div className="pb-2">
      <div className="px-4 pt-8 pb-4 text-center">
        <h3 className="font-display text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        <p className="font-ui text-sm" style={{ color: 'var(--text-secondary)' }}>
          {message}
        </p>
      </div>
      {catalog.map((src) => (
        <SourceToggleRow
          key={src.id}
          source={src}
          isEnabled={selectedSourceIds.includes(src.id)}
          onToggle={toggleSource}
        />
      ))}
    </div>
  );
}
