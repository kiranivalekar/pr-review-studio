const VARIANTS = {
  // Standard content panel.
  default: "border border-hairline bg-surface shadow-[var(--shadow-card)]",
  // Frosted — for panels that sit over the aurora background.
  glass: "glass shadow-[var(--shadow-card)]",
  // Raised one step, for things that should read as "on top".
  elevated: "border border-hairline bg-elevated shadow-[var(--shadow-lift)]",
  // Gradient hairline, for the one card in a group that's being recommended.
  featured: "ring-gradient bg-surface shadow-[var(--shadow-card)]",
  // No chrome at all — layout-only grouping.
  plain: "bg-transparent",
};

export function Card({ variant = "default", hover = false, className = "", ...props }) {
  return (
    <div
      className={`rounded-2xl ${VARIANTS[variant]} ${hover ? "lift" : ""} ${className}`}
      {...props}
    />
  );
}
