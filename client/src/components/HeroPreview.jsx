import { useEffect, useState } from "react";
import { Check, CornerDownLeft, Sparkles } from "lucide-react";

// A miniature of the real Review screen, played as a short loop: the diff draws
// itself in line by line, Claude "thinks", an inline comment lands on the
// offending line with a suggestion block, and it gets pushed. It's the product
// demo — so it mirrors the actual UI's colours and line grammar rather than
// inventing a prettier fiction.
const DIFF = [
  { type: "ctx", n: 41, text: "export async function getUser(id) {" },
  { type: "del", n: 42, text: "  const res = await fetch(`/api/users/${id}`);" },
  { type: "add", n: 42, text: "  const res = await fetch(`/api/users/${id}`, {" },
  { type: "add", n: 43, text: "    headers: { Authorization: token }," },
  { type: "add", n: 44, text: "  });" },
  { type: "ctx", n: 45, text: "  return res.json();" },
  { type: "ctx", n: 46, text: "}" },
];

const LINE_STYLES = {
  ctx: "text-muted",
  add: "bg-add-bg text-add-ink",
  del: "bg-del-bg text-del-ink",
};
const SIGILS = { ctx: " ", add: "+", del: "-" };

const TOTAL_STEPS = DIFF.length + 3; // diff lines, then thinking, comment, pushed

export function HeroPreview() {
  const [step, setStep] = useState(0);

  // One timer walks the whole sequence, then holds before restarting — a single
  // index is far easier to reason about than a pile of per-element timeouts.
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setStep(TOTAL_STEPS);
      return;
    }
    const delay = step >= TOTAL_STEPS ? 3600 : step === DIFF.length ? 900 : 320;
    const id = setTimeout(() => setStep((s) => (s >= TOTAL_STEPS ? 0 : s + 1)), delay);
    return () => clearTimeout(id);
  }, [step]);

  const thinking = step === DIFF.length;
  const showComment = step > DIFF.length;
  const pushed = step > DIFF.length + 1;

  return (
    <div className="relative">
      {/* Ambient glow behind the panel. */}
      <div
        aria-hidden
        className="absolute -inset-6 rounded-[2rem] bg-linear-140 from-brand/25 via-brand-3/15 to-accent/20 blur-3xl"
      />

      <div className="glass relative animate-float overflow-hidden rounded-2xl shadow-[var(--shadow-lift)]">
        {/* Window chrome */}
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-red-400/80" />
            <span className="size-2.5 rounded-full bg-amber-400/80" />
            <span className="size-2.5 rounded-full bg-emerald-400/80" />
          </span>
          <span className="ml-2 truncate font-mono text-[11px] text-faint">src/lib/api.js</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 ring-1 ring-emerald-500/25 ring-inset dark:text-emerald-300">
            +3 −1
          </span>
        </div>

        {/* Diff */}
        <div className="px-1 py-2 font-mono text-[11.5px] leading-[1.9]">
          {DIFF.map((line, i) => (
            <div
              key={i}
              className={`flex gap-3 px-3 transition-all duration-500 ${LINE_STYLES[line.type]} ${
                i < step ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"
              } ${
                showComment && line.n === 43 && line.type === "add"
                  ? "ring-1 ring-brand/40 ring-inset"
                  : ""
              }`}
            >
              <span className="w-5 shrink-0 text-right text-faint tabular-nums">{line.n}</span>
              <span className="w-2 shrink-0 opacity-70">{SIGILS[line.type]}</span>
              <span className="truncate whitespace-pre">{line.text}</span>
            </div>
          ))}
        </div>

        {/* Claude working */}
        <div
          className={`overflow-hidden transition-all duration-500 ${
            thinking ? "max-h-16 opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <div className="mx-3 mb-3 flex items-center gap-2 rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-[11px] text-muted">
            <Sparkles size={13} className="animate-pulse text-brand" />
            Claude is reading the diff and the surrounding code…
          </div>
        </div>

        {/* The comment Claude leaves */}
        <div
          className={`overflow-hidden transition-all duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
            showComment ? "max-h-72 opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <div className="mx-3 mb-3 rounded-xl border border-hairline bg-surface p-3 shadow-[var(--shadow-card)]">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 ring-1 ring-amber-500/25 ring-inset dark:text-amber-300">
                <span className="size-1.5 rounded-full bg-amber-500" />
                issue
              </span>
              <span className="font-mono text-[10px] text-faint">api.js:43</span>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink">
              The token is sent raw — every other call in this file uses the{" "}
              <span className="font-mono text-[11px] text-brand">Bearer</span> scheme, so this
              request will 401.
            </p>

            {/* Suggestion block, the way GitHub renders one */}
            <div className="mt-2.5 overflow-hidden rounded-lg border border-emerald-500/25">
              <div className="bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                Suggested change
              </div>
              <div className="bg-add-bg px-2.5 py-1.5 font-mono text-[11px] text-add-ink">
                {"headers: { Authorization: `Bearer ${token}` },"}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all duration-500 ${
                  pushed
                    ? "bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/25 ring-inset dark:text-emerald-300"
                    : "bg-linear-120 from-brand-2 via-brand to-brand-3 text-white"
                }`}
              >
                {pushed ? <Check size={12} /> : <CornerDownLeft size={12} />}
                {pushed ? "Pushed to GitHub" : "Push 1 comment"}
              </span>
              <span className="text-[10px] text-faint">
                {pushed ? "status → commented" : "you decide"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
