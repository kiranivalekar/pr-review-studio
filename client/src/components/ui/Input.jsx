export function Input({ className = "", ...props }) {
  return (
    <input
      className={`h-9 rounded-xl border border-hairline bg-surface-2 px-3 text-sm text-ink transition-[border-color,box-shadow,background] duration-300 placeholder:text-faint hover:border-hairline-strong focus:border-brand focus:bg-surface focus:outline-none focus:ring-4 focus:ring-brand/20 ${className}`}
      {...props}
    />
  );
}
