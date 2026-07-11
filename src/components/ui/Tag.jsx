export default function Tag({ color, sourceName, meta }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
      fontSize: 'var(--step--1)', letterSpacing: '.06em', textTransform: 'uppercase',
      fontWeight: 700, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)' }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: color || 'var(--accent)' }} />
      {sourceName}
      {meta && <span style={{ color: 'var(--text-tertiary)', fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>· {meta}</span>}
    </span>
  );
}
