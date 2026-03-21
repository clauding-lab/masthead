export default function RefreshButton({ isLoading, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      className="p-2 rounded-lg transition-colors"
      style={{ color: isLoading ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
      aria-label="Refresh feeds"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={isLoading ? 'animate-spin' : ''}
      >
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
    </button>
  );
}
