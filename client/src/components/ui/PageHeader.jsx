// One header shape for every app screen: eyebrow → title → description on the
// left, actions on the right. Keeps Assigned PRs and Review visually parented
// to the same grid instead of each inventing its own heading rhythm.
export function PageHeader({ eyebrow, icon: Icon, title, description, actions, className = "" }) {
  return (
    <header className={`flex flex-wrap items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0 animate-fade-up">
        {eyebrow && (
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-hairline bg-surface-2 px-2.5 py-1 text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            {Icon && <Icon size={12} strokeWidth={2.4} className="text-brand" />}
            {eyebrow}
          </div>
        )}
        <h1 className="truncate text-[26px] leading-tight font-bold tracking-[-0.02em] text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex animate-fade-up items-center gap-2 [animation-delay:80ms]">{actions}</div>
      )}
    </header>
  );
}
