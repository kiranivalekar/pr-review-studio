import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Coins, Home, ListChecks, Sparkles } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";
import { fetchUsage } from "../api";
import { formatTokenCount, totalTokens } from "../lib/formatUsage";

const NAV_ITEMS = [
  { to: "/", label: "Home", end: true, icon: Home },
  { to: "/prs", label: "Review queue", end: false, icon: ListChecks },
];

// Running total across today's reviews only (data/db.json's reviews, each carrying the
// cost/tokens the claude CLI itself reported) — a lightweight GET /api/usage sum scoped
// server-side to the local calendar day, so it clears on its own at midnight instead of
// needing an explicit reset, and can never drift from the review records.
function UsageSummary() {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    fetchUsage()
      .then(setUsage)
      .catch(() => {});
  }, []);

  if (!usage || usage.reviewCount === 0) return null;

  const title = [
    `${usage.reviewCount} review${usage.reviewCount === 1 ? "" : "s"} today`,
    `Input: ${usage.inputTokens.toLocaleString()}`,
    `Output: ${usage.outputTokens.toLocaleString()}`,
    `Cache read: ${usage.cacheReadInputTokens.toLocaleString()}`,
    `Cache creation: ${usage.cacheCreationInputTokens.toLocaleString()}`,
  ].join("\n");

  return (
    <div title={title} className="mb-3 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[10px] font-bold tracking-[0.14em] text-faint uppercase">
        <Coins size={11} strokeWidth={2.4} className="text-brand" />
        Today
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg leading-none font-bold text-ink tabular-nums">
          {formatTokenCount(totalTokens(usage))}
        </span>
        <span className="text-[11px] text-faint">tokens</span>
      </div>
      <div className="mt-1 text-[11px] text-muted">
        {usage.reviewCount} review{usage.reviewCount === 1 ? "" : "s"} run
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <nav className="sticky top-0 z-30 flex h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-hairline bg-surface/60 p-4 backdrop-blur-xl">
      <div className="px-1 py-2">
        <BrandMark size="md" />
      </div>

      <ul className="mt-6 flex flex-col gap-1">
        {NAV_ITEMS.map(({ to, label, end, icon: Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `group relative flex items-center gap-2.5 overflow-hidden rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-300 ${
                  isActive ? "bg-brand/10 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {/* Active rail — scales up from the left edge rather than appearing. */}
                  <span
                    aria-hidden
                    className={`absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-linear-to-b from-brand-2 to-brand-3 transition-transform duration-300 ${
                      isActive ? "scale-y-100" : "scale-y-0"
                    }`}
                  />
                  <Icon
                    size={16}
                    strokeWidth={2}
                    className={`shrink-0 transition-colors ${isActive ? "text-brand" : ""}`}
                  />
                  {label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      {/* A quiet reminder of what's doing the work, and where it runs. */}
      <div className="mt-6 rounded-xl border border-hairline bg-linear-140 from-brand/8 to-transparent px-3 py-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-ink">
          <Sparkles size={12} className="text-brand" />
          Claude Code
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          Headless, on your logged-in CLI. No API key leaves this machine.
        </p>
      </div>

      <div className="mt-auto pt-4">
        <UsageSummary />
        <ThemeToggle />
      </div>
    </nav>
  );
}
