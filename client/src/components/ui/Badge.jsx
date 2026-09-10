// Each badge is a tinted wash + matching ring + a dot in the same hue, so
// status reads at a glance from colour alone before the label is even parsed.
export const BADGE_VARIANTS = {
  // PR source
  assigned: { wash: "bg-sky-500/10 text-sky-600 ring-sky-500/25 dark:text-sky-300", dot: "bg-sky-500" },
  manual: { wash: "bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-300", dot: "bg-amber-500" },

  // PR status
  unreviewed: { wash: "bg-faint/10 text-muted ring-faint/25", dot: "bg-faint" },
  reviewed: { wash: "bg-brand/12 text-brand ring-brand/30", dot: "bg-brand" },
  commented: { wash: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300", dot: "bg-emerald-500" },

  // Comment severity
  nit: { wash: "bg-faint/10 text-muted ring-faint/25", dot: "bg-faint" },
  suggestion: { wash: "bg-sky-500/10 text-sky-600 ring-sky-500/25 dark:text-sky-300", dot: "bg-sky-500" },
  issue: { wash: "bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-300", dot: "bg-amber-500" },
  blocking: { wash: "bg-red-500/10 text-red-600 ring-red-500/25 dark:text-red-300", dot: "bg-red-500" },

  // Generic
  brand: { wash: "bg-brand/12 text-brand ring-brand/30", dot: "bg-brand" },
  neutral: { wash: "bg-faint/10 text-muted ring-faint/25", dot: "bg-faint" },
};

export function Badge({ variant = "unreviewed", dot = true, className = "", children }) {
  const style = BADGE_VARIANTS[variant] ?? BADGE_VARIANTS.unreviewed;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1 ring-inset ${style.wash} ${className}`}
    >
      {dot && <span aria-hidden className={`size-1.5 rounded-full ${style.dot}`} />}
      {children}
    </span>
  );
}
