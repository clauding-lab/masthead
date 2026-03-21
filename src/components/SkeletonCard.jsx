export default function SkeletonCard() {
  return (
    <div className="flex gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="skeleton w-10 h-5 rounded" />
        </div>
        <div className="skeleton w-full h-4 rounded mb-2" />
        <div className="skeleton w-3/4 h-4 rounded mb-2" />
        <div className="skeleton w-1/2 h-4 rounded mb-2" />
        <div className="flex items-center gap-2 mt-2">
          <div className="skeleton w-12 h-3 rounded" />
          <div className="skeleton w-20 h-3 rounded" />
        </div>
      </div>
      <div className="skeleton flex-shrink-0 w-20 h-20 rounded-lg" />
    </div>
  );
}
