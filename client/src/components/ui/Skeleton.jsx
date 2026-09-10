export function Skeleton({ className = "" }) {
  return <div aria-hidden className={`skeleton rounded-lg ${className}`} />;
}
