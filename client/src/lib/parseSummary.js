export const VERDICT_STYLES = {
  APPROVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  "APPROVE WITH MINOR CHANGES": "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400",
  "CHANGES REQUESTED": "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  BLOCK: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
};

// Summaries are written as "Verdict: <VERDICT> — <sentences>" — split that prefix out
// so the verdict can render as its own badge instead of plain text at the front.
export function parseSummary(summary) {
  const match = summary?.match(/^Verdict:\s*(APPROVE WITH MINOR CHANGES|APPROVE|CHANGES REQUESTED|BLOCK)\s*(?:—|-)\s*/i);
  if (!match) return { verdict: null, text: summary };
  return { verdict: match[1].toUpperCase(), text: summary.slice(match[0].length).trim() };
}
