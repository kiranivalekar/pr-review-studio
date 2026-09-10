import { Card } from "./Card";

// Shared empty/idle panel. The icon sits in a glowing brand halo so an empty
// screen still looks designed rather than broken.
export function EmptyState({ icon: Icon, title, description, action, className = "" }) {
  return (
    <Card className={`flex animate-scale-in flex-col items-center gap-3 px-6 py-14 text-center ${className}`}>
      {Icon && (
        <span className="relative grid size-12 place-items-center rounded-2xl border border-hairline bg-surface-2 text-brand">
          <span
            aria-hidden
            className="absolute inset-0 rounded-2xl bg-brand/15 blur-xl"
          />
          <Icon size={20} strokeWidth={1.8} className="relative" />
        </span>
      )}
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </Card>
  );
}
