const VARIANTS = {
  primary:
    "bg-zinc-900 text-white hover:bg-zinc-700 disabled:bg-zinc-300 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:disabled:bg-zinc-700",
  ghost:
    "bg-transparent text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
  danger:
    "bg-transparent text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10",
};

export function Button({ variant = "primary", className = "", ...props }) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
