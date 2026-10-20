export default function Loading() {
  return (
    <div className="loading-page" aria-label="Loading workspace" role="status">
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-subheading" />
      <div className="stats-grid">
        {[1, 2, 3].map((item) => (
          <div className="skeleton skeleton-stat" key={item} />
        ))}
      </div>
      <div className="skeleton skeleton-panel" />
      <span className="sr-only">Loading workspace evidence…</span>
    </div>
  );
}
