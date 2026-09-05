/** A loading indicator, not a duration estimate. */
export function LoadingRing() {
  return (
    <svg className="reader-loading-ring" width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx="32" cy="32" r="30" className="reader-loading-track" strokeWidth="2" />
      <circle cx="32" cy="32" r="30" className="reader-loading-arc" strokeWidth="2"
        strokeLinecap="round" strokeDasharray="48 140" transform="rotate(-90 32 32)" />
    </svg>
  );
}
