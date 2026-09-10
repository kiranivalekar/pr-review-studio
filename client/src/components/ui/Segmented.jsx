const SIZES = {
  sm: { pad: 2, box: "p-0.5", item: "h-6 gap-1.5 px-2 text-[11px]", glyph: 11 },
  md: { pad: 4, box: "p-1", item: "h-8 gap-2 px-3 text-xs", glyph: 13 },
};

// Segmented control with a single sliding indicator — the active pill is one
// absolutely-positioned element that transitions between slots, rather than a
// per-option background fading in and out. Cheaper, and reads as one object
// moving instead of two states cross-fading.
export function Segmented({ options, value, onChange, size = "md", className = "" }) {
  const { pad, box, item, glyph } = SIZES[size];
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );

  // Percentages resolve against the padding box, but the buttons only occupy
  // the content box — so the track has to have both paddings subtracted before
  // it's divided, or the indicator drifts further off with every slot.
  const track = `(100% - ${pad * 2}px)`;

  return (
    <div
      role="tablist"
      className={`relative inline-flex shrink-0 items-center rounded-xl border border-hairline bg-surface-2 ${box} ${className}`}
    >
      <span
        aria-hidden
        className="absolute rounded-lg bg-surface shadow-[var(--shadow-card)] ring-1 ring-hairline transition-[left,width] duration-[350ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{
          top: pad,
          bottom: pad,
          left: `calc(${pad}px + ${activeIndex} * ${track} / ${options.length})`,
          width: `calc(${track} / ${options.length})`,
        }}
      />
      {options.map((option) => {
        const Icon = option.icon;
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={`relative z-10 inline-flex flex-1 items-center justify-center rounded-lg font-semibold whitespace-nowrap transition-colors duration-300 ${item} ${
              isActive ? "text-ink" : "text-faint hover:text-muted"
            }`}
          >
            {Icon && <Icon size={glyph} strokeWidth={2.2} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
