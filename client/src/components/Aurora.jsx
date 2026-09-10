// The app's signature background: three slow-drifting colour fields under a
// blueprint grid and a film-grain layer. Fixed and pointer-transparent, so it
// costs nothing in layout and never intercepts a click.
//
// `intensity` is the difference between the landing page (full bloom) and the
// working screens (a whisper behind the content, so the diff stays readable).
const INTENSITY = {
  full: { opacity: "opacity-100", blur: "blur-[110px]", size: "size-[46rem]" },
  soft: { opacity: "opacity-45", blur: "blur-[130px]", size: "size-[34rem]" },
};

export function Aurora({ intensity = "full", grid = true, className = "" }) {
  const { opacity, blur, size } = INTENSITY[intensity];

  return (
    <div
      aria-hidden
      className={`grain pointer-events-none fixed inset-0 -z-10 overflow-hidden ${className}`}
    >
      {/* Base wash, so the blobs bloom out of the canvas rather than sit on it. */}
      <div className="absolute inset-0 bg-canvas" />

      <div className={`absolute inset-0 ${opacity}`}>
        <div className={`absolute -top-40 -left-32 ${size} animate-aurora rounded-full bg-brand/28 ${blur}`} />
        <div
          className={`absolute -top-24 right-[-12rem] ${size} animate-aurora rounded-full bg-accent/20 ${blur} [animation-delay:-8s]`}
        />
        <div
          className={`absolute bottom-[-22rem] left-1/3 ${size} animate-aurora rounded-full bg-brand-3/20 ${blur} [animation-delay:-15s]`}
        />
      </div>

      {grid && <div className="absolute inset-0 grid-bg" />}

      {/* Vignette — pulls attention back to the centre column. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,transparent_35%,var(--canvas)_92%)]" />
    </div>
  );
}
