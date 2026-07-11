const base = {
  fontFamily: 'var(--font-ui)', fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
  borderRadius: '999px', transition: 'transform var(--dur-fast) var(--ease-out), background-color var(--dur-fast)',
};
const variants = {
  primary: { background: 'var(--accent)', color: '#fff', border: 'none', padding: '9px 16px' },
  ghost:   { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '8px 14px' },
  icon:    { background: 'transparent', color: 'var(--text-secondary)', border: 'none', width: 36, height: 36, justifyContent: 'center', padding: 0 },
};
export default function Button({ as: As = 'button', variant = 'ghost', className = '', style = {}, children, ...rest }) {
  return (
    <As className={`mh-btn ${className}`} style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {children}
    </As>
  );
}
