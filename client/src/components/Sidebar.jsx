import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { ListChecks, Coins } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { fetchUsage } from "../api";
import { formatTokenCount, totalTokens } from "../lib/formatUsage";

const NAV_ITEMS = [{ to: "/", label: "Assigned PRs", end: true, icon: ListChecks }];

// Running total across today's reviews only (data/db.json's reviews, each carrying the
// cost/tokens the claude CLI itself reported) — a lightweight GET /api/usage sum scoped
// server-side to the local calendar day, so it clears on its own at midnight instead of
// needing an explicit reset, and can never drift from the review records.
function UsageSummary() {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    fetchUsage().then(setUsage).catch(() => {});
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
    <div
      title={title}
      className="mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-zinc-500 dark:text-zinc-400"
    >
      <Coins size={14} strokeWidth={2} className="shrink-0" />
      <span>
        {formatTokenCount(totalTokens(usage))} tokens
      </span>
    </div>
  );
}

export function Sidebar() {
  return (
    <nav className="sticky top-0 flex h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-6 px-2 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
        PR Review Studio
      </div>
      <ul className="flex flex-col gap-0.5">
        {NAV_ITEMS.map(({ to, label, end, icon: Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                }`
              }
            >
              <Icon size={16} strokeWidth={2} />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <UsageSummary />
        <ThemeToggle />
      </div>
    </nav>
  );
}
