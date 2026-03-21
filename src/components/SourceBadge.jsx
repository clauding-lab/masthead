export default function SourceBadge({ shortName, color }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-ui font-semibold"
      style={{
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--accent)',
        borderLeft: `3px solid ${color}`,
      }}
    >
      {shortName}
    </span>
  );
}
