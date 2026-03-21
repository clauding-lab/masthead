export default function EmptyState({ title, message, action, onAction }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
      {/* Red line art icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ color: 'var(--accent)', opacity: 0.5 }}
      >
        <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
        <path d="M18 14h-8" />
        <path d="M15 18h-5" />
        <path d="M10 6h8v4h-8V6Z" />
      </svg>
      <h3
        className="font-display text-lg font-semibold mt-4 mb-1"
        style={{ color: 'var(--text-primary)' }}
      >
        {title}
      </h3>
      <p className="font-ui text-sm max-w-xs" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
      {action && onAction && (
        <button
          onClick={onAction}
          className="mt-4 px-6 py-2 rounded-full font-ui text-sm font-medium transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--accent)', color: '#FFFFFF' }}
        >
          {action}
        </button>
      )}
    </div>
  );
}
