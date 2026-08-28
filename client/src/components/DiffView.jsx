import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Columns2, Loader2, MessageSquare, Rows3 } from "lucide-react";
import { CommentCard } from "./CommentCard";
import { toSplitRows, fileElementId, computeGaps } from "../lib/parseDiff";
import { fetchFileContent } from "../api";

const GAP_CHUNK = 20;

const LINE_BG = {
  add: "bg-emerald-50 dark:bg-emerald-500/10",
  del: "bg-red-50 dark:bg-red-500/10",
  context: "",
};

const LINE_PREFIX = { add: "+", del: "-", context: " " };

const LINE_NUM_CLASS =
  "w-10 select-none border-r border-zinc-200 px-2 text-right text-zinc-400 dark:border-zinc-800 dark:text-zinc-600";

function CommentThreadRow({ colSpan, entries, viewMode, onCommentUpdate, selectedIds, onSelectChange }) {
  if (entries.length === 0) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-2 font-sans">
          {entries.map(({ comment, originalContent }) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              originalContent={originalContent}
              viewMode={viewMode}
              showLocation={false}
              onUpdate={(patch) => onCommentUpdate(comment.id, patch)}
              selected={selectedIds.has(comment.id)}
              onSelectChange={(checked) => onSelectChange(comment.id, checked)}
            />
          ))}
        </div>
      </td>
    </tr>
  );
}

function UnifiedLineRows({ filePath, line, matcher, onCommentUpdate, selectedIds, onSelectChange }) {
  const entries = matcher
    .commentsForLine(filePath, line)
    .map((comment) => ({ comment, originalContent: line.content }));
  const highlighted = entries.length > 0;
  return (
    <>
      <tr className={LINE_BG[line.type]}>
        <td className={LINE_NUM_CLASS}>{line.oldLine ?? ""}</td>
        <td className={LINE_NUM_CLASS}>{line.newLine ?? ""}</td>
        <td
          className={`whitespace-pre-wrap break-all px-2 py-0.5 text-zinc-800 dark:text-zinc-200 ${
            highlighted ? "border-l-2 border-amber-400 bg-amber-50/60 dark:border-amber-500 dark:bg-amber-500/10" : ""
          }`}
        >
          <span className="select-none text-zinc-400">{LINE_PREFIX[line.type]}</span>
          {highlighted && (
            <MessageSquare size={10} className="mr-1 inline-block shrink-0 align-text-top text-amber-500" />
          )}
          {line.content}
        </td>
      </tr>
      <CommentThreadRow
        colSpan={3}
        viewMode="unified"
        entries={entries}
        onCommentUpdate={onCommentUpdate}
        selectedIds={selectedIds}
        onSelectChange={onSelectChange}
      />
    </>
  );
}

function UnifiedHunk({ filePath, hunk, matcher, onCommentUpdate, selectedIds, onSelectChange }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="bg-indigo-50/60 px-3 py-1 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((line, li) => (
        <Fragment key={li}>
          <UnifiedLineRows
            filePath={filePath}
            line={line}
            matcher={matcher}
            onCommentUpdate={onCommentUpdate}
            selectedIds={selectedIds}
            onSelectChange={onSelectChange}
          />
        </Fragment>
      ))}
    </>
  );
}

function splitCell(line, side, highlighted) {
  if (!line) {
    return (
      <>
        <td className={LINE_NUM_CLASS} />
        <td className="bg-zinc-50 px-2 py-0.5 dark:bg-zinc-900/40" />
      </>
    );
  }
  const tint = side === "left" ? LINE_BG.del : LINE_BG.add;
  const active = side === "left" ? line.type === "del" : line.type === "add";
  return (
    <>
      <td className={LINE_NUM_CLASS}>{side === "left" ? line.oldLine : line.newLine}</td>
      <td
        className={`whitespace-pre-wrap break-all px-2 py-0.5 text-zinc-800 dark:text-zinc-200 ${active ? tint : ""} ${
          highlighted ? "border-l-2 border-amber-400 bg-amber-50/60 dark:border-amber-500 dark:bg-amber-500/10" : ""
        }`}
      >
        {highlighted && (
          <MessageSquare size={10} className="mr-1 inline-block shrink-0 align-text-top text-amber-500" />
        )}
        {line.content}
      </td>
    </>
  );
}

// A context line sits on both sides at once (row.left === row.right, same object), so
// its comments can't be routed by "which line object" alone — LEFT/RIGHT-side comments
// on that single line are split by comment.side so each lands under the correct column.
function splitRowEntries(matcher, filePath, row) {
  const left = row.left
    ? matcher
        .commentsForLine(filePath, row.left)
        .filter((c) => c.side === "LEFT")
        .map((comment) => ({ comment, originalContent: row.left.content }))
    : [];
  const right = row.right
    ? matcher
        .commentsForLine(filePath, row.right)
        .filter((c) => c.side === "RIGHT")
        .map((comment) => ({ comment, originalContent: row.right.content }))
    : [];
  return { left, right };
}

function SplitCommentCell({ entries, onCommentUpdate, selectedIds, onSelectChange }) {
  if (entries.length === 0) return <td colSpan={2} />;
  return (
    <td colSpan={2} className="border-t border-zinc-200 bg-white p-3 align-top dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-col gap-2 font-sans">
        {entries.map(({ comment, originalContent }) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            originalContent={originalContent}
            viewMode="split"
            showLocation={false}
            onUpdate={(patch) => onCommentUpdate(comment.id, patch)}
            selected={selectedIds.has(comment.id)}
            onSelectChange={(checked) => onSelectChange(comment.id, checked)}
          />
        ))}
      </div>
    </td>
  );
}

function SplitPairRow({ filePath, row, matcher, onCommentUpdate, selectedIds, onSelectChange }) {
  const { left, right } = splitRowEntries(matcher, filePath, row);
  return (
    <>
      <tr>
        {splitCell(row.left, "left", left.length > 0)}
        {splitCell(row.right, "right", right.length > 0)}
      </tr>
      {(left.length > 0 || right.length > 0) && (
        <tr>
          <SplitCommentCell entries={left} onCommentUpdate={onCommentUpdate} selectedIds={selectedIds} onSelectChange={onSelectChange} />
          <SplitCommentCell entries={right} onCommentUpdate={onCommentUpdate} selectedIds={selectedIds} onSelectChange={onSelectChange} />
        </tr>
      )}
    </>
  );
}

function SplitLineRow({ filePath, line, matcher, onCommentUpdate, selectedIds, onSelectChange }) {
  return (
    <SplitPairRow
      filePath={filePath}
      row={{ left: line, right: line }}
      matcher={matcher}
      onCommentUpdate={onCommentUpdate}
      selectedIds={selectedIds}
      onSelectChange={onSelectChange}
    />
  );
}

function SplitHunk({ filePath, hunk, matcher, onCommentUpdate, selectedIds, onSelectChange }) {
  const rows = toSplitRows(hunk.lines);
  return (
    <>
      <tr>
        <td colSpan={4} className="bg-indigo-50/60 px-3 py-1 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
          {hunk.header}
        </td>
      </tr>
      {rows.map((row, ri) => (
        <Fragment key={ri}>
          <SplitPairRow
            filePath={filePath}
            row={row}
            matcher={matcher}
            onCommentUpdate={onCommentUpdate}
            selectedIds={selectedIds}
            onSelectChange={onSelectChange}
          />
        </Fragment>
      ))}
    </>
  );
}

// Renders the hidden-lines separator between hunks (or before the first / after the
// last). "lead"/"trail" gaps only have one open edge (no hunk on the other side), so
// they get a single expand affordance; "mid" gaps get both directions, each growing
// independently until they meet and the separator disappears.
function GapSeparatorRow({ colSpan, gap, remaining, loading, error, onExpand }) {
  const label = loading
    ? "Loading…"
    : error
    ? `Failed to load file: ${error}`
    : remaining == null
    ? "Show more lines"
    : `${remaining} hidden line${remaining === 1 ? "" : "s"}`;

  return (
    <tr>
      <td colSpan={colSpan} className="border-y border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          {gap.kind === "mid" && (
            <button
              onClick={() => onExpand("down")}
              disabled={loading}
              title="Show more lines below the hunk above"
              className="rounded p-0.5 hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-zinc-700"
            >
              <ChevronDown size={14} />
            </button>
          )}
          <button
            onClick={() => onExpand(gap.kind === "mid" ? "down" : gap.kind === "lead" ? "up" : "down")}
            disabled={loading}
            className="flex-1 rounded px-1.5 py-0.5 text-left font-mono hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-zinc-700"
          >
            {loading && <Loader2 size={12} className="mr-1 inline animate-spin" />}
            {label}
          </button>
          {gap.kind === "mid" && (
            <button
              onClick={() => onExpand("up")}
              disabled={loading}
              title="Show more lines above the hunk below"
              className="rounded p-0.5 hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-zinc-700"
            >
              <ChevronUp size={14} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// revealed.top counts lines shown starting at gap.newStart growing toward gap.newEnd
// (i.e. extending the hunk above downward); revealed.bottom counts lines shown ending
// at gap.newEnd growing backward (extending the hunk below upward). Both directions
// are independent so the two edges can be expanded separately, same as GitHub.
function gapRevealState(gap, revealed, linesArr) {
  const effectiveEnd = gap.newEnd ?? (linesArr ? linesArr.length : null);
  const gapSize = effectiveEnd != null ? effectiveEnd - gap.newStart + 1 : null;
  const remaining = gapSize != null ? gapSize - revealed.top - revealed.bottom : null;

  const topLines = [];
  const bottomLines = [];
  if (linesArr) {
    for (let n = gap.newStart; n < gap.newStart + revealed.top; n++) {
      topLines.push({ type: "context", newLine: n, oldLine: n - gap.offset, content: linesArr[n - 1] ?? "" });
    }
    if (effectiveEnd != null) {
      for (let n = effectiveEnd - revealed.bottom + 1; n <= effectiveEnd; n++) {
        bottomLines.push({ type: "context", newLine: n, oldLine: n - gap.offset, content: linesArr[n - 1] ?? "" });
      }
    }
  }
  return { topLines, bottomLines, remaining };
}

function UnifiedGap({ filePath, gap, linesArr, revealed, loading, error, onExpand, matcher, onCommentUpdate, selectedIds, onSelectChange }) {
  const { topLines, bottomLines, remaining } = gapRevealState(gap, revealed, linesArr);
  const showSeparator = remaining == null || remaining > 0;
  return (
    <>
      {topLines.map((line, li) => (
        <UnifiedLineRows
          key={`top-${li}`}
          filePath={filePath}
          line={line}
          matcher={matcher}
          onCommentUpdate={onCommentUpdate}
          selectedIds={selectedIds}
          onSelectChange={onSelectChange}
        />
      ))}
      {showSeparator && (
        <GapSeparatorRow colSpan={3} gap={gap} remaining={remaining} loading={loading} error={error} onExpand={onExpand} />
      )}
      {bottomLines.map((line, li) => (
        <UnifiedLineRows
          key={`bot-${li}`}
          filePath={filePath}
          line={line}
          matcher={matcher}
          onCommentUpdate={onCommentUpdate}
          selectedIds={selectedIds}
          onSelectChange={onSelectChange}
        />
      ))}
    </>
  );
}

function SplitGap({ filePath, gap, linesArr, revealed, loading, error, onExpand, matcher, onCommentUpdate, selectedIds, onSelectChange }) {
  const { topLines, bottomLines, remaining } = gapRevealState(gap, revealed, linesArr);
  const showSeparator = remaining == null || remaining > 0;
  return (
    <>
      {topLines.map((line, li) => (
        <SplitLineRow
          key={`top-${li}`}
          filePath={filePath}
          line={line}
          matcher={matcher}
          onCommentUpdate={onCommentUpdate}
          selectedIds={selectedIds}
          onSelectChange={onSelectChange}
        />
      ))}
      {showSeparator && (
        <GapSeparatorRow colSpan={4} gap={gap} remaining={remaining} loading={loading} error={error} onExpand={onExpand} />
      )}
      {bottomLines.map((line, li) => (
        <SplitLineRow
          key={`bot-${li}`}
          filePath={filePath}
          line={line}
          matcher={matcher}
          onCommentUpdate={onCommentUpdate}
          selectedIds={selectedIds}
          onSelectChange={onSelectChange}
        />
      ))}
    </>
  );
}

// Interleaves each file's hunks with the gaps computed around them, in document order,
// so the two segment kinds can be mapped over as one flat list when rendering.
function buildSegments(file) {
  const gaps = computeGaps(file);
  const gapAfterHunk = new Map();
  let leadGap = null;
  for (const gap of gaps) {
    if (gap.kind === "lead") leadGap = gap;
    else gapAfterHunk.set(gap.afterHunkIndex, gap);
  }
  const segments = [];
  if (leadGap) segments.push({ kind: "gap", gap: leadGap });
  file.hunks.forEach((hunk, hi) => {
    segments.push({ kind: "hunk", hunk });
    const gap = gapAfterHunk.get(hi);
    if (gap) segments.push({ kind: "gap", gap });
  });
  return segments;
}

export function DiffView({ files, matcher, onCommentUpdate, selectedIds, onSelectChange, owner, repo, number }) {
  const [mode, setMode] = useState("unified");
  const [collapsedFiles, setCollapsedFiles] = useState(new Set());
  const [fileLinesCache, setFileLinesCache] = useState({});
  const [gapReveal, setGapReveal] = useState({});
  const [loadingGapId, setLoadingGapId] = useState(null);
  const [gapError, setGapError] = useState({});

  function toggleFileCollapsed(path) {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleExpandGap(file, gap, direction) {
    setGapError((prev) => ({ ...prev, [gap.id]: null }));
    let linesArr = fileLinesCache[file.path];
    if (!linesArr) {
      setLoadingGapId(gap.id);
      try {
        const text = await fetchFileContent(owner, repo, number, file.path);
        linesArr = text.split("\n");
        setFileLinesCache((prev) => ({ ...prev, [file.path]: linesArr }));
      } catch (err) {
        setGapError((prev) => ({ ...prev, [gap.id]: err.message }));
        setLoadingGapId(null);
        return;
      }
      setLoadingGapId(null);
    }

    const effectiveEnd = gap.newEnd ?? linesArr.length;
    const gapSize = effectiveEnd - gap.newStart + 1;

    setGapReveal((prev) => {
      const cur = prev[gap.id] ?? { top: 0, bottom: 0 };
      let { top, bottom } = cur;
      if (gap.kind === "lead") {
        top = gapSize;
      } else if (gap.kind === "trail") {
        top = Math.min(top + GAP_CHUNK, gapSize);
      } else if (direction === "down") {
        top = Math.min(top + GAP_CHUNK, gapSize - bottom);
      } else {
        bottom = Math.min(bottom + GAP_CHUNK, gapSize - top);
      }
      return { ...prev, [gap.id]: { top, bottom } };
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-1 self-end rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
        <button
          onClick={() => setMode("unified")}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            mode === "unified"
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
        >
          <Rows3 size={13} />
          Unified
        </button>
        <button
          onClick={() => setMode("split")}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            mode === "split"
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
        >
          <Columns2 size={13} />
          Split
        </button>
      </div>

      {files.map((file) => {
        const collapsed = collapsedFiles.has(file.path);
        const segments = file.binary ? [] : buildSegments(file);
        return (
          <div
            key={file.path}
            id={fileElementId(file.path)}
            className="scroll-mt-4 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
          >
            <button
              onClick={() => toggleFileCollapsed(file.path)}
              className="flex w-full items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-left font-mono text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {collapsed ? (
                  <ChevronRight size={13} className="shrink-0 text-zinc-400" />
                ) : (
                  <ChevronDown size={13} className="shrink-0 text-zinc-400" />
                )}
                <span className="min-w-0 break-all">{file.path}</span>
              </span>
              <span className="flex shrink-0 gap-2">
                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
              </span>
            </button>

            {!collapsed &&
              (file.binary ? (
                <div className="p-3 text-xs text-zinc-500 dark:text-zinc-400">Binary file not shown</div>
              ) : (
                <table className="w-full table-fixed border-collapse font-mono text-xs">
                  <colgroup>
                    {mode === "split" ? (
                      <>
                        <col className="w-10" />
                        <col className="w-[calc(50%-2.5rem)]" />
                        <col className="w-10" />
                        <col className="w-[calc(50%-2.5rem)]" />
                      </>
                    ) : (
                      <>
                        <col className="w-10" />
                        <col className="w-10" />
                        <col />
                      </>
                    )}
                  </colgroup>
                  <tbody>
                    {segments.map((seg, si) =>
                      seg.kind === "hunk" ? (
                        mode === "split" ? (
                          <SplitHunk
                            key={si}
                            filePath={file.path}
                            hunk={seg.hunk}
                            matcher={matcher}
                            onCommentUpdate={onCommentUpdate}
                            selectedIds={selectedIds}
                            onSelectChange={onSelectChange}
                          />
                        ) : (
                          <UnifiedHunk
                            key={si}
                            filePath={file.path}
                            hunk={seg.hunk}
                            matcher={matcher}
                            onCommentUpdate={onCommentUpdate}
                            selectedIds={selectedIds}
                            onSelectChange={onSelectChange}
                          />
                        )
                      ) : mode === "split" ? (
                        <SplitGap
                          key={si}
                          filePath={file.path}
                          gap={seg.gap}
                          linesArr={fileLinesCache[file.path]}
                          revealed={gapReveal[seg.gap.id] ?? { top: 0, bottom: 0 }}
                          loading={loadingGapId === seg.gap.id}
                          error={gapError[seg.gap.id]}
                          onExpand={(dir) => handleExpandGap(file, seg.gap, dir)}
                          matcher={matcher}
                          onCommentUpdate={onCommentUpdate}
                          selectedIds={selectedIds}
                          onSelectChange={onSelectChange}
                        />
                      ) : (
                        <UnifiedGap
                          key={si}
                          filePath={file.path}
                          gap={seg.gap}
                          linesArr={fileLinesCache[file.path]}
                          revealed={gapReveal[seg.gap.id] ?? { top: 0, bottom: 0 }}
                          loading={loadingGapId === seg.gap.id}
                          error={gapError[seg.gap.id]}
                          onExpand={(dir) => handleExpandGap(file, seg.gap, dir)}
                          matcher={matcher}
                          onCommentUpdate={onCommentUpdate}
                          selectedIds={selectedIds}
                          onSelectChange={onSelectChange}
                        />
                      )
                    )}
                  </tbody>
                </table>
              ))}
          </div>
        );
      })}
    </div>
  );
}
