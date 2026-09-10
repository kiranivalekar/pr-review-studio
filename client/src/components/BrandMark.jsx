import { Link } from "react-router-dom";

const SIZES = {
  sm: { box: "size-7 rounded-lg", glyph: 14, text: "text-sm", sub: "hidden" },
  md: { box: "size-9 rounded-xl", glyph: 18, text: "text-[15px]", sub: "block" },
};

// The logo: a gradient tile holding a hand-drawn review glyph — a branch line
// with a review comment landing on it. Lucide has no "commented pull request"
// icon, and the wordmark deserves a mark that means the actual product.
export function BrandMark({ size = "md", withWordmark = true, to = "/", className = "" }) {
  const s = SIZES[size];

  const mark = (
    <span
      className={`relative grid shrink-0 place-items-center ${s.box} bg-linear-140 from-brand-2 via-brand to-brand-3 text-white shadow-[0_6px_18px_-8px_var(--glow)]`}
    >
      <span aria-hidden className={`absolute inset-0 ${s.box} bg-brand/40 blur-md`} />
      <svg
        viewBox="0 0 24 24"
        width={s.glyph}
        height={s.glyph}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative"
      >
        {/* the branch line, top node to bottom node */}
        <circle cx="6" cy="4.2" r="1.8" fill="currentColor" stroke="none" />
        <path d="M6 6.2v11.6" />
        <circle cx="6" cy="19.8" r="1.8" fill="currentColor" stroke="none" />
        {/* the review comment landing on it */}
        <rect x="11.5" y="4" width="9.5" height="7.5" rx="2.4" />
        <path d="M14.5 11.5v2.6a3 3 0 0 1-3 3H9" />
      </svg>
    </span>
  );

  const content = (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      {mark}
      {withWordmark && (
        <span className="min-w-0 leading-none">
          <span className={`block font-bold tracking-[-0.02em] text-ink ${s.text}`}>
            PR Review <span className="text-gradient">Studio</span>
          </span>
          <span
            className={`mt-1 ${s.sub} text-[10px] font-medium tracking-[0.16em] text-faint uppercase`}
          >
            Local · Claude Code
          </span>
        </span>
      )}
    </span>
  );

  return to ? (
    <Link to={to} className="rounded-xl transition-opacity hover:opacity-85">
      {content}
    </Link>
  ) : (
    content
  );
}
