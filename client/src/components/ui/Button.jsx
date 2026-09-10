const VARIANTS = {
  // The one call-to-action look: brand gradient + glow, with a light sweep on hover.
  primary:
    "bg-linear-120 from-brand-2 via-brand to-brand-3 text-white shadow-[0_8px_24px_-10px_var(--glow)] hover:shadow-[0_12px_32px_-10px_var(--glow)] hover:brightness-110 disabled:shadow-none",
  // Neutral solid, for confirm actions that shouldn't compete with `primary`.
  solid:
    "bg-ink text-canvas hover:opacity-90",
  // Bordered — the default for row-level and toolbar actions.
  secondary:
    "border border-hairline bg-surface text-ink hover:border-hairline-strong hover:bg-surface-2",
  ghost:
    "text-muted hover:bg-surface-2 hover:text-ink",
  subtle:
    "bg-brand/10 text-brand hover:bg-brand/16",
  danger:
    "text-bad hover:bg-bad/10",
};

const SIZES = {
  sm: "h-7 gap-1.5 rounded-lg px-2.5 text-xs",
  md: "h-9 gap-2 rounded-xl px-3.5 text-sm",
  lg: "h-12 gap-2.5 rounded-2xl px-6 text-[15px]",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}) {
  const isPrimary = variant === "primary";

  return (
    <button
      className={`group relative inline-flex shrink-0 items-center justify-center font-medium transition-[background,color,box-shadow,border-color,transform,filter] duration-300 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 ${
        isPrimary ? "shine" : ""
      } ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {isPrimary && <span aria-hidden className="shine-bar" />}
      {children}
    </button>
  );
}
