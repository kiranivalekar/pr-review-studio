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

  useEffect(() => setText(comment.text), [comment.text]);
  useEffect(() => setSuggestion(comment.suggestion ?? ""), [comment.suggestion]);

  return (
    <Card className={`p-4 ${dismissed ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        {showLocation ? (
          <span className="min-w-0 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">
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
              className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600"
            />
          )}
          <select
            value={comment.severity}
            disabled={locked}
            onChange={(e) => onUpdate({ severity: e.target.value })}
            className={`rounded-full border-0 px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset focus:outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:cursor-not-allowed ${BADGE_VARIANTS[comment.severity]}`}
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
          className="mt-2 w-full min-h-[2.5rem] rounded-lg border border-zinc-300 bg-white p-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
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
            locked ? "" : "cursor-text hover:border-zinc-200 dark:hover:border-zinc-800"
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
              className="absolute right-1.5 top-1.5 rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-200/70 hover:text-zinc-700 group-hover/text:opacity-100 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
      )}

      {comment.suggestion != null && (
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-300 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
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
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            >
              {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {originalContent != null && viewMode === "split" ? (
            <div className="grid grid-cols-2 divide-x divide-zinc-300 dark:divide-zinc-700">
              <pre className="m-0 overflow-x-auto whitespace-pre bg-red-50 p-2 font-mono text-xs leading-relaxed text-zinc-800 dark:bg-red-500/10 dark:text-zinc-200">
                {originalContent}
              </pre>
              <Textarea
                className="w-full min-h-[2rem] overflow-x-auto whitespace-pre bg-emerald-50 p-2 font-mono text-xs leading-relaxed text-zinc-900 focus:outline-none disabled:cursor-not-allowed dark:bg-emerald-500/10 dark:text-zinc-100"
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
                <pre className="m-0 overflow-x-auto whitespace-pre bg-red-50 px-2 py-1 font-mono text-xs leading-relaxed text-zinc-800 dark:bg-red-500/10 dark:text-zinc-200">
                  <span className="select-none text-red-400">- </span>
                  {originalContent}
                </pre>
              )}
              <Textarea
                className="w-full min-h-[2rem] overflow-x-auto whitespace-pre bg-emerald-50 p-2 font-mono text-xs leading-relaxed text-zinc-900 focus:outline-none disabled:cursor-not-allowed dark:bg-emerald-500/10 dark:text-zinc-100"
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
