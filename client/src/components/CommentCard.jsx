import { useEffect, useState } from "react";
import { Ban, Undo2, Check, Copy, Lightbulb, Pencil } from "lucide-react";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";
import { Badge, BADGE_VARIANTS } from "./ui/Badge";
import { Textarea } from "./ui/Textarea";
import { Markdown } from "./Markdown";

const SEVERITIES = ["nit", "suggestion", "issue", "blocking"];

export function CommentCard({
  comment,
  onUpdate,
  showLocation = true,
  originalContent,
  viewMode = "unified",
  selected = false,
  onSelectChange,
}) {
  const [text, setText] = useState(comment.text);
  const [suggestion, setSuggestion] = useState(comment.suggestion ?? "");
  const [copied, setCopied] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const dismissed = comment.state === "dismissed";
  const pushed = comment.state === "pushed";
  const locked = dismissed || pushed;

  useEffect(() => {
    setText(comment.text);
  }, [comment.text]);
  useEffect(() => {
    setSuggestion(comment.suggestion ?? "");
  }, [comment.suggestion]);

  return (
    <Card className={`p-4 ${dismissed ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        {showLocation ? (
          <span className="min-w-0 break-all font-mono text-xs text-muted">
            {comment.file}
            {comment.line ? `:${comment.line}` : ""}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {!locked && (
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onSelectChange?.(e.target.checked)}
              title="Include in next push to GitHub"
              className="h-3.5 w-3.5 rounded border-hairline text-brand focus:ring-brand"
            />
          )}
          <select
            value={comment.severity}
            disabled={locked}
            onChange={(e) => onUpdate({ severity: e.target.value })}
            className={`rounded-full border-0 px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:cursor-not-allowed ${BADGE_VARIANTS[comment.severity]}`}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {pushed ? (
            <Badge variant="commented">Pushed</Badge>
          ) : (
            <Button
              variant="ghost"
              onClick={() => onUpdate({ state: dismissed ? "suggested" : "dismissed" })}
            >
              {dismissed ? <Undo2 size={14} /> : <Ban size={14} />}
              {dismissed ? "Restore" : "Dismiss"}
            </Button>
          )}
        </div>
      </div>

      {editingText ? (
        <Textarea
          className="mt-2 w-full min-h-[2.5rem] rounded-lg border border-hairline bg-white p-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60"
          value={text}
          autoFocus
          disabled={locked}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setEditingText(false);
            if (text !== comment.text) onUpdate({ text });
          }}
        />
      ) : (
        <div
          className={`group/text relative mt-2 rounded-lg border border-transparent p-2 ${
            locked ? "" : "cursor-text hover:border-hairline-strong"
          }`}
          onClick={(e) => {
            // Let links inside the rendered markdown navigate instead of entering edit mode,
            // and don't hijack a click that's actually the end of a text-selection drag.
            if (locked || e.target.closest("a") || window.getSelection()?.toString()) return;
            setEditingText(true);
          }}
        >
          <Markdown>{text}</Markdown>
          {!locked && (
            <button
              type="button"
              onClick={() => setEditingText(true)}
              title="Edit"
              className="absolute right-1.5 top-1.5 rounded p-1 text-faint opacity-0 hover:bg-surface-2 hover:text-ink group-hover/text:opacity-100"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
      )}

      {comment.suggestion != null && (
        <div className="mt-2 overflow-hidden rounded-lg border border-hairline">
          <div className="flex items-center justify-between gap-2 border-b border-hairline bg-surface-2 px-3 py-1 text-xs font-medium text-muted">
            <span className="flex items-center gap-1.5">
              <Lightbulb size={12} className="text-amber-500" />
              Suggested change
            </span>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(suggestion);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title="Copy suggestion"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-ink"
            >
              {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {originalContent != null && viewMode === "split" ? (
            <div className="grid grid-cols-2 divide-x divide-hairline">
              <pre className="m-0 overflow-x-auto whitespace-pre bg-red-50 p-2 font-mono text-xs leading-relaxed text-ink dark:bg-red-500/10">
                {originalContent}
              </pre>
              <Textarea
                className="w-full min-h-[2rem] overflow-x-auto whitespace-pre bg-emerald-50 p-2 font-mono text-xs leading-relaxed text-ink focus:outline-none disabled:cursor-not-allowed dark:bg-emerald-500/10"
                value={suggestion}
                disabled={locked}
                onChange={(e) => setSuggestion(e.target.value)}
                onBlur={() => {
                  if (suggestion !== comment.suggestion) onUpdate({ suggestion });
                }}
              />
            </div>
          ) : (
            <div className="flex flex-col">
              {originalContent != null && (
                <pre className="m-0 overflow-x-auto whitespace-pre bg-red-50 px-2 py-1 font-mono text-xs leading-relaxed text-ink dark:bg-red-500/10">
                  <span className="select-none text-red-400">- </span>
                  {originalContent}
                </pre>
              )}
              <Textarea
                className="w-full min-h-[2rem] overflow-x-auto whitespace-pre bg-emerald-50 p-2 font-mono text-xs leading-relaxed text-ink focus:outline-none disabled:cursor-not-allowed dark:bg-emerald-500/10"
                value={suggestion}
                disabled={locked}
                onChange={(e) => setSuggestion(e.target.value)}
                onBlur={() => {
                  if (suggestion !== comment.suggestion) onUpdate({ suggestion });
                }}
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
