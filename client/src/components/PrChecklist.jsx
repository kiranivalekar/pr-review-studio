import { CheckCircle2, CircleDashed, TriangleAlert } from "lucide-react";
import { Card } from "./ui/Card";

const STATUS_META = {
  pass: {
    icon: CheckCircle2,
    iconClass: "text-emerald-500 dark:text-emerald-400",
    label: "Pass",
    badgeClass:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
  },
  warning: {
    icon: TriangleAlert,
    iconClass: "text-amber-500 dark:text-amber-400",
    label: "Warning",
    badgeClass: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  },
  unchecked: {
    icon: CircleDashed,
    iconClass: "text-zinc-400 dark:text-zinc-500",
    label: "Unchecked",
    badgeClass: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  },
};

// Order sections appear in, and their header text — "common" applies regardless of
// stack, "backend"/"frontend" are marked "unchecked" by the model itself (see
// SUMMARY_PROMPT in claude.py) when the diff doesn't touch that stack at all.
const GROUP_ORDER = ["common", "backend", "frontend"];
const GROUP_LABEL = { common: "General", backend: "Backend", frontend: "Frontend" };

function ChecklistRow({ item }) {
  const meta = STATUS_META[item.status] || STATUS_META.unchecked;
  const Icon = meta.icon;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Icon size={18} className={`mt-0.5 shrink-0 ${meta.iconClass}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.label}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.badgeClass}`}>
            {meta.label}
          </span>
        </div>
        {item.note && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{item.note}</p>}
      </div>
    </div>
  );
}

// Server-driven list (id/label/group/status/note all come from the review record —
// see CHECKLIST_ITEMS in claude.py) so this component never needs its own copy of the
// checklist's labels/groups to stay in sync with the backend.
export function PrChecklist({ review }) {
  const items = review.checklist || [];

  if (items.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        No checklist recorded for this review (run before the PR checklist was added).
      </Card>
    );
  }

  // "Unchecked" items (not applicable to this diff, e.g. backend items on a
  // frontend-only PR) don't count toward the pass ratio — otherwise a single-stack PR
  // would always look partially failed.
  const applicable = items.filter((i) => i.status !== "unchecked");
  const passCount = applicable.filter((i) => i.status === "pass").length;
  const warningCount = applicable.filter((i) => i.status === "warning").length;

  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((i) => (i.group || "common") === group),
  })).filter((g) => g.items.length > 0);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">PR checklist</h2>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {applicable.length > 0 ? `${passCount}/${applicable.length} passed` : "nothing applicable"}
          {warningCount > 0 ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {groups.map(({ group, items: groupItems }) => (
        <div key={group} className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <div className="bg-zinc-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
            {GROUP_LABEL[group] || group}
          </div>
          {groupItems.map((item) => (
            <ChecklistRow key={item.id} item={item} />
          ))}
        </div>
      ))}
    </Card>
  );
}
