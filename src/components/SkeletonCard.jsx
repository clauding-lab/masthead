export default function SkeletonCard() {
  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
      <div className="flex items-center gap-2 mb-1.5">
        <div className="skeleton w-10 h-5 rounded" />
      </div>
      <div className="skeleton w-full h-4 rounded mb-1.5" />
      <div className="skeleton w-full h-4 rounded mb-1.5" />
      <div className="skeleton w-2/5 h-4 rounded mb-1.5" />
      <div className="flex items-center gap-2">
        <div className="skeleton w-12 h-3 rounded" />
        <div className="skeleton w-20 h-3 rounded" />
      </div>
    </div>
  );
}
