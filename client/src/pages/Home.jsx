import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  Coins,
  FolderGit2,
  Gauge,
  GitPullRequestArrow,
  Layers,
  Link2,
  ListChecks,
  MessageSquareCode,
  MousePointerClick,
  Rocket,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Telescope,
  Wand2,
  Zap,
} from "lucide-react";
import { fetchReviews, fetchUsage } from "../api";
import { getCachedPrs } from "../lib/prsCache";
import { formatTokenCount, totalTokens } from "../lib/formatUsage";
import { useCountUp, useSpotlight, useTypewriter } from "../lib/useMotion";
import { useReveal } from "../lib/useReveal";
import { Aurora } from "../components/Aurora";
import { TopNav } from "../components/TopNav";
import { HeroPreview } from "../components/HeroPreview";
import { BrandMark } from "../components/BrandMark";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";

const ROTATING = ["the diff.", "the codebase.", "the linked PRs.", "your dependencies.", "your PHPStan level."];

const FEATURES = [
  {
    icon: MessageSquareCode,
    title: "Comments on the real diff",
    body: "Unified or split view, file tree, hunk expansion — and every finding pinned to the exact line it's about, not a flat list you have to cross-reference.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing ships without you",
    body: "Every comment is editable: rewrite it, change severity, tune the suggested code, or dismiss it. GitHub only ever sees what you tick.",
  },
  {
    icon: Layers,
    title: "Three depths of review",
    body: "Diff-only when you want speed, local context when you want references, deep review when Claude should read the codebase around the change.",
  },
  {
    icon: Link2,
    title: "Cross-PR awareness",
    body: "Link the backend PR your frontend change depends on. Claude checks consistency across both without reviewing the other PR's code for its own bugs.",
  },
  {
    icon: Wand2,
    title: "Suggestions GitHub can apply",
    body: "A concrete line fix renders as a native suggestion block — the author gets a real Apply suggestion button, not a code fence to copy by hand.",
  },
  {
    icon: Zap,
    title: "Clear a repo in one pass",
    body: "Select several PRs in a repo group and batch-review them together. Diff-only and bounded to three at a time, so cost stays predictable.",
  },
];

const STEPS = [
  { icon: ScanSearch, title: "Discover", body: "Every PR where your review is requested, grouped by repo — plus anything you add by URL." },
  { icon: FolderGit2, title: "Open", body: "The diff renders GitHub-style: file tree, diffstat, split view, expandable hunks." },
  { icon: Telescope, title: "Gather context", body: "Linked PRs, dependency manifests, PHPStan config, and optionally a worktree of the real repo." },
  { icon: Sparkles, title: "Review", body: "The logged-in Claude CLI runs headless against a JSON schema — batched per file, token-budgeted." },
  { icon: MousePointerClick, title: "Curate", body: "Read the write-up, work the checklist, edit or dismiss each comment, tick what deserves to ship." },
  { icon: Rocket, title: "Publish", body: "One atomic inline review lands on GitHub and the PR flips to commented." },
];

const MODES = [
  {
    icon: Gauge,
    name: "Diff only",
    tagline: "Fast and cheap",
    cost: 1,
    body: "Reviews the diff itself with no repository tools — still enriched with linked PRs, dependencies and PHPStan config.",
    points: ["No local clone needed", "Seconds, not minutes", "Powers batch review"],
  },
  {
    icon: Layers,
    name: "Local context",
    tagline: "The everyday default",
    cost: 2,
    featured: true,
    body: "Checks the PR out locally, finds the files that reference what changed, and pastes bounded snippets into one prompt.",
    points: ["Sees real call sites", "One shot, no tool loop", "Falls back to diff-only"],
  },
  {
    icon: Telescope,
    name: "Deep review",
    tagline: "When it really matters",
    cost: 3,
    body: "Runs inside a disposable git worktree with read-only Read, Grep and Glob so Claude explores the codebase around the change.",
    points: ["Reads the actual repo", "Never touches your branch", "Slowest, most thorough"],
  },
];

const MARQUEE = [
  "review-requested",
  "inline suggestions",
  "split diff",
  "git worktree",
  "linked PRs",
  "PHPStan aware",
  "batch review",
  "token budgeted",
  "dark mode",
  "100% local",
];

// One stat tile. Numbers count up when they land so the strip feels live rather
// than pre-rendered.
function Stat({ icon: Icon, label, value, suffix, loading, hint }) {
  const animated = useCountUp(value ?? 0);

  return (
    <div className="reveal group relative flex-1 px-5 py-4" title={hint}>
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
        <Icon size={13} strokeWidth={2.2} className="text-brand" />
        {label}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <div className="mt-1 text-2xl font-bold tracking-[-0.02em] text-ink tabular-nums">
          {value === null ? <span className="text-faint">—</span> : suffix ? suffix(animated) : animated}
        </div>
      )}
    </div>
  );
}

function FeatureCard({ icon: Icon, title, body, delay }) {
  const { ref, onMouseMove } = useSpotlight();

  return (
    <Card
      ref={ref}
      onMouseMove={onMouseMove}
      hover
      className="spotlight reveal group p-6"
      style={{ "--d": `${delay}ms` }}
    >
      <span className="relative inline-grid size-11 place-items-center rounded-xl border border-hairline bg-surface-2 text-brand transition-colors duration-500 group-hover:border-brand/40">
        <span aria-hidden className="absolute inset-0 rounded-xl bg-brand/15 opacity-0 blur-lg transition-opacity duration-500 group-hover:opacity-100" />
        <Icon size={19} strokeWidth={1.9} className="relative" />
      </span>
      <h3 className="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
    </Card>
  );
}

export function Home() {
  const reveal = useReveal();
  const typed = useTypewriter(ROTATING);

  const [stats, setStats] = useState({ reviews: null, pushed: null, usage: null });
  const [loading, setLoading] = useState(true);

  // Only the cheap, local endpoints run on the landing page. GET /api/prs is a
  // fan-out of live GitHub calls (~7s on a full queue), so the queue tile reuses
  // the list if another screen has already fetched it this session and shows a
  // dash otherwise — a landing page shouldn't cost a round of API quota.
  const queueCount = getCachedPrs()?.length ?? null;

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchReviews().catch(() => []), fetchUsage().catch(() => null)])
      .then(([reviews, usage]) => {
        if (cancelled) return;
        const pushed = reviews.reduce(
          (sum, review) => sum + review.comments.filter((c) => c.state === "pushed").length,
          0
        );
        setStats({ reviews: reviews.length, pushed, usage });
      })
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div ref={reveal} className="relative min-h-screen">
      <Aurora intensity="full" />
      <TopNav />

      {/* ================= HERO ================= */}
      <section className="mx-auto flex max-w-6xl flex-col items-center px-6 pt-36 pb-20 lg:pt-44">
        <Link
          to="/prs"
          className="group inline-flex animate-fade-up items-center gap-2 rounded-full border border-hairline bg-surface/70 py-1.5 pr-2 pl-3 text-xs font-medium text-muted backdrop-blur transition-colors duration-300 hover:border-brand/40 hover:text-ink"
        >
          <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
          Runs entirely on your machine, on your logged-in Claude CLI
          <ArrowRight size={13} className="transition-transform duration-300 group-hover:translate-x-0.5" />
        </Link>

        <h1 className="mt-7 max-w-4xl animate-fade-up text-center text-[clamp(2.5rem,7vw,4.5rem)] leading-[1.03] font-extrabold tracking-[-0.04em] text-balance text-ink [animation-delay:80ms]">
          Review pull requests
          <br />
          <span className="text-gradient">at the speed of thought.</span>
        </h1>

        <p className="mt-6 max-w-xl animate-fade-up text-center text-[17px] leading-relaxed text-balance text-muted [animation-delay:160ms]">
          Claude reads{" "}
          <span className="font-medium text-ink">
            {typed}
            <span className="ml-0.5 inline-block h-[1.1em] w-px animate-caret bg-brand align-[-0.15em]" />
          </span>
          <br className="hidden sm:block" />
          You keep the judgement, and the last word.
        </p>

        <div className="mt-9 flex animate-fade-up flex-wrap items-center justify-center gap-3 [animation-delay:240ms]">
          <Link to="/prs">
            <Button variant="primary" size="lg">
              Let's start reviewing PRs
              <ArrowRight size={17} className="transition-transform duration-300 group-hover:translate-x-1" />
            </Button>
          </Link>
          <a href="#how">
            <Button variant="secondary" size="lg">
              See how it works
            </Button>
          </a>
        </div>

        <p className="mt-4 animate-fade-up text-xs text-faint [animation-delay:300ms]">
          No sign-in · No telemetry · Your token, your machine
        </p>

        {/* Live numbers from this install */}
        <Card
          variant="glass"
          className="mt-14 w-full animate-fade-up overflow-hidden [animation-delay:360ms]"
        >
          <div className="flex flex-wrap divide-x divide-hairline">
            <Stat
              icon={GitPullRequestArrow}
              label="In your queue"
              value={queueCount}
              loading={false}
              hint={queueCount === null ? "Open the queue to sync from GitHub" : undefined}
            />
            <Stat icon={ListChecks} label="Reviews run" value={stats.reviews} loading={loading} />
            <Stat icon={CheckCircle2} label="Comments pushed" value={stats.pushed} loading={loading} />
            <Stat
              icon={Coins}
              label="Tokens today"
              value={stats.usage ? totalTokens(stats.usage) : 0}
              suffix={(n) => formatTokenCount(n)}
              loading={loading}
              hint="Summed across today's reviews — clears at local midnight"
            />
          </div>
        </Card>

        <div className="mt-16 w-full max-w-3xl animate-fade-up [animation-delay:440ms]">
          <HeroPreview />
        </div>
      </section>

      {/* ================= MARQUEE ================= */}
      <div className="relative overflow-hidden border-y border-hairline bg-surface/40 py-3.5 backdrop-blur">
        <div className="flex w-max animate-marquee items-center gap-3">
          {[...MARQUEE, ...MARQUEE].map((item, i) => (
            <span key={i} className="flex items-center gap-3">
              <span className="font-mono text-xs tracking-tight whitespace-nowrap text-faint">
                {item}
              </span>
              <span className="size-1 rounded-full bg-brand/50" />
            </span>
          ))}
        </div>
        {/* Feathered edges so items enter and leave instead of clipping. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-28 bg-linear-to-r from-canvas to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-28 bg-linear-to-l from-canvas to-transparent" />
      </div>

      {/* ================= FEATURES ================= */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
        <div className="reveal max-w-2xl">
          <SectionEyebrow icon={Sparkles}>What it does</SectionEyebrow>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.75rem)] leading-[1.1] font-bold tracking-[-0.03em] text-balance text-ink">
            A review surface built for <span className="text-gradient">judgement</span>, not just output.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            The model drafts. You decide. Everything here exists to make that second half fast.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <FeatureCard key={feature.title} {...feature} delay={i * 70} />
          ))}
        </div>
      </section>

      {/* ================= HOW IT WORKS ================= */}
      <section id="how" className="relative scroll-mt-24 border-y border-hairline bg-surface/30 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="reveal max-w-2xl">
            <SectionEyebrow icon={ArrowRight}>The flow</SectionEyebrow>
            <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.75rem)] leading-[1.1] font-bold tracking-[-0.03em] text-balance text-ink">
              Six steps from <span className="text-gradient">queue</span> to published review.
            </h2>
          </div>

          <ol className="relative mt-14 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((step, i) => (
              <li
                key={step.title}
                className="reveal relative pl-14"
                style={{ "--d": `${i * 80}ms` }}
              >
                {/* Connector — stops short of the last item in each row. */}
                <span
                  aria-hidden
                  className="absolute top-11 left-[21px] h-[calc(100%-1rem)] w-px bg-linear-to-b from-brand/40 to-transparent"
                />
                <span className="absolute top-0 left-0 grid size-11 place-items-center rounded-xl border border-hairline bg-surface text-brand shadow-[var(--shadow-card)]">
                  <step.icon size={18} strokeWidth={1.9} />
                </span>
                <span className="text-[11px] font-bold tracking-[0.16em] text-faint uppercase">
                  Step {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-1 text-[15px] font-semibold text-ink">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ================= MODES ================= */}
      <section id="modes" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
        <div className="reveal max-w-2xl">
          <SectionEyebrow icon={Gauge}>Review modes</SectionEyebrow>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.75rem)] leading-[1.1] font-bold tracking-[-0.03em] text-balance text-ink">
            Pick the <span className="text-gradient">depth</span> the change deserves.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            Chosen per run. Every mode degrades gracefully to diff-only rather than failing when a
            local clone isn't there.
          </p>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {MODES.map((mode, i) => (
            <Card
              key={mode.name}
              variant={mode.featured ? "featured" : "default"}
              hover
              className="reveal relative flex flex-col p-6"
              style={{ "--d": `${i * 90}ms` }}
            >
              {mode.featured && (
                <span className="absolute -top-2.5 left-6 rounded-full bg-linear-120 from-brand-2 via-brand to-brand-3 px-2.5 py-0.5 text-[10px] font-bold tracking-[0.1em] text-white uppercase shadow-[0_6px_16px_-6px_var(--glow)]">
                  Recommended
                </span>
              )}
              <div className="flex items-start justify-between gap-3">
                <span className="grid size-11 place-items-center rounded-xl border border-hairline bg-surface-2 text-brand">
                  <mode.icon size={19} strokeWidth={1.9} />
                </span>
                <span className="flex items-center gap-1" title={`Relative cost: ${mode.cost} of 3`}>
                  {[1, 2, 3].map((n) => (
                    <span
                      key={n}
                      className={`size-1.5 rounded-full transition-colors ${
                        n <= mode.cost ? "bg-brand" : "bg-hairline-strong"
                      }`}
                    />
                  ))}
                </span>
              </div>
              <h3 className="mt-4 text-lg font-bold tracking-[-0.01em] text-ink">{mode.name}</h3>
              <p className="text-xs font-semibold text-brand">{mode.tagline}</p>
              <p className="mt-3 text-sm leading-relaxed text-muted">{mode.body}</p>
              <ul className="mt-5 flex flex-col gap-2 border-t border-hairline pt-4">
                {mode.points.map((point) => (
                  <li key={point} className="flex items-center gap-2 text-[13px] text-muted">
                    <CheckCircle2 size={14} className="shrink-0 text-brand" />
                    {point}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </section>

      {/* ================= CTA ================= */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <Card
          variant="glass"
          className="reveal relative overflow-hidden px-8 py-16 text-center sm:px-16"
        >
          <div
            aria-hidden
            className="absolute -top-32 left-1/2 size-[34rem] -translate-x-1/2 animate-aurora rounded-full bg-brand/20 blur-[120px]"
          />
          <div className="relative">
            <h2 className="text-[clamp(1.8rem,4vw,2.6rem)] leading-tight font-bold tracking-[-0.03em] text-balance text-ink">
              Ready to clear the queue?
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-balance text-muted">
              Open the review queue and run your first pass. Nothing reaches GitHub until you say so.
            </p>
            <div className="mt-8 flex justify-center">
              <Link to="/prs">
                <Button variant="primary" size="lg">
                  Let's start reviewing PRs
                  <ArrowRight size={17} className="transition-transform duration-300 group-hover:translate-x-1" />
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      </section>

      {/* ================= FOOTER ================= */}
      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8">
          <BrandMark size="sm" />
          <p className="text-xs text-faint">
            Built to run on one machine, for one reviewer — with Claude Code.
          </p>
        </div>
      </footer>
    </div>
  );
}

function SectionEyebrow({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface-2 px-3 py-1 text-[11px] font-bold tracking-[0.16em] text-muted uppercase">
      <Icon size={12} strokeWidth={2.4} className="text-brand" />
      {children}
    </span>
  );
}
