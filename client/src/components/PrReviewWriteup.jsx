import { Sparkles } from "lucide-react";
import { Card } from "./ui/Card";
import { CommentCard } from "./CommentCard";
import { Markdown } from "./Markdown";
import { VERDICT_STYLES, parseSummary } from "../lib/parseSummary";

const SEVERITY_ORDER = ["blocking", "issue", "suggestion", "nit"];
const SEVERITY_DOT = {
  blocking: "bg-red-500",
  issue: "bg-amber-500",
  suggestion: "bg-sky-500",
  nit: "bg-zinc-400 dark:bg-zinc-500",
};

function bySeverity(comments) {
  return [...comments].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

// One consolidated write-up of the whole review — summary up top, then every comment
// (matched to a diff line or not, doesn't matter here) as a numbered, severity-ordered
// list. Same underlying comment data/actions as the inline-on-diff view (DiffView +
// CommentCard) — this is just a different read of it, not a separate data source.
export function PrReviewWriteup({ review, onCommentUpdate, selectedIds, onSelectChange }) {
  const { verdict, text } = parseSummary(review.summary);
  const ordered = bySeverity(review.comments);

  return (
    <div className="flex flex-col gap-4">
      {review.summary && (
        <Card className="flex items-start gap-3 p-4">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">PR review</h2>
              {verdict && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${VERDICT_STYLES[verdict]}`}>
                  {verdict}
                </span>
              )}
            </div>
            <div className="mt-1">
              <Markdown>{text}</Markdown>
            </div>
          </div>
        </Card>
      )}

      {ordered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Claude didn't flag anything in this diff.
        </Card>
      ) : (
        ordered.map((comment, i) => (
          <div key={comment.id} className="flex items-start gap-3">
            <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${SEVERITY_DOT[comment.severity]}`} />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                <span>{i + 1}.</span>
                <span className="truncate">
                  {comment.file}
                  {comment.line ? `:${comment.line}` : ""}
                </span>
              </div>
              <CommentCard
                comment={comment}
                showLocation={false}
                onUpdate={(patch) => onCommentUpdate(comment.id, patch)}
                selected={selectedIds.has(comment.id)}
                onSelectChange={(checked) => onSelectChange(comment.id, checked)}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
