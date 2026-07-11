export default function Surface({ as: As = 'div', raised = false, className = '', style = {}, children, ...rest }) {
  return (
    <As
      className={className}
      style={{
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        boxShadow: raised ? 'var(--shadow-2)' : 'none',
        ...style,
      }}
      {...rest}
    >
      {children}
    </As>
  );
}
