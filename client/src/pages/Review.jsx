import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  CheckCircle2,
  ExternalLink,
  Link2,
  ListChecks,
  Loader2,
  PanelLeft,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import {
  fetchPRs,
  runReview,
  fetchReviews,
  fetchPRDiff,
  patchComment,
  pushReview,
  addLinkedPR,
  removeLinkedPR,
} from "../api";
import { getCachedPrs, setCachedPrs } from "../lib/prsCache";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { DiffStat } from "../components/DiffStat";
import { DiffView } from "../components/DiffView";
import { FileTree } from "../components/FileTree";
import { CommentCard } from "../components/CommentCard";
import { PrReviewWriteup } from "../components/PrReviewWriteup";
import { PrChecklist } from "../components/PrChecklist";
import { parseUnifiedDiff, matchCommentsToDiff, buildFileTree, fileElementId } from "../lib/parseDiff";
import { VERDICT_STYLES, parseSummary } from "../lib/parseSummary";
import { formatTokenCount, totalTokens } from "../lib/formatUsage";

function isPushable(comment) {
  return comment.state !== "dismissed" && comment.state !== "pushed";
}

const RUN_MODE_HINTS = {
  diff: "Fastest and cheapest — reviews just the diff, no local codebase access.",
  curated:
    "Checks out the PR locally and pastes bounded snippets of files that reference the diff's changes into one prompt — more context than diff-only, without the slower/costlier interactive exploration Deep review does.",
  deep: "Checks out the PR locally and lets Claude interactively read the surrounding codebase (Read/Grep/Glob) — most thorough, but slowest and most expensive.",
};

// Linked PRs are stored as "owner/repo#123" keys (db.pr_key's format).
function parseLinkedKey(key) {
  const idx = key.lastIndexOf("#");
  return { repo: key.slice(0, idx), number: Number(key.slice(idx + 1)) };
}

export function Review() {
  const { owner, repo, number } = useParams();
  const fullRepo = `${owner}/${repo}`;
  const prNumber = Number(number);

  const [pr, setPr] = useState(null);
  const [review, setReview] = useState(null);
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [runMode, setRunMode] = useState("diff"); // "diff" | "curated" | "deep"
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [treeOpen, setTreeOpen] = useState(true);
  const [activeFile, setActiveFile] = useState(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linking, setLinking] = useState(false);
  const [reviewMode, setReviewMode] = useState("inline"); // "inline" | "writeup" | "checklist"

  // Reuses the Assigned PRs list cached by that screen instead of re-fetching
  // it just to read one entry — only falls back to a real /api/prs call when
  // there's no cache yet (e.g. this PR's review URL was opened directly).
  function loadPr() {
    const cached = getCachedPrs();
    if (cached) {
      return Promise.resolve(cached.find((p) => p.repo === fullRepo && p.number === prNumber) ?? null);
    }
    return fetchPRs().then((prs) => {
      setCachedPrs(prs);
      return prs.find((p) => p.repo === fullRepo && p.number === prNumber) ?? null;
    });
  }

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      loadPr(),
      fetchReviews({ repo: fullRepo, number: prNumber }),
      fetchPRDiff(owner, repo, prNumber),
    ])
      .then(([foundPr, reviews, diff]) => {
        setPr(foundPr);
        const latest = [...reviews].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        setReview(latest ?? null);
        setDiffText(diff);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  // Guards against React StrictMode's dev-only double-invoke of effects, which
  // otherwise fires every fetch here (prs/reviews/diff) twice on each load.
  const loadedKeyRef = useRef(null);
  useEffect(() => {
    const key = `${fullRepo}#${prNumber}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    load();
  }, [fullRepo, prNumber, owner, repo]);

  // Default to "everything pushable is selected" whenever a different review loads;
  // dismiss/restore on the same review doesn't reset this (comment.state already
  // hides the checkbox for dismissed/pushed comments, so stale ids in the set are harmless).
  useEffect(() => {
    if (!review) return;
    setSelectedIds(new Set(review.comments.filter(isPushable).map((c) => c.id)));
  }, [review?.id]);

  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const matcher = useMemo(
    () => matchCommentsToDiff(files, review?.comments ?? []),
    [files, review]
  );
  const fileTree = useMemo(() => buildFileTree(files), [files]);

  function handleSelectFile(path) {
    setActiveFile(path);
    document.getElementById(fileElementId(path))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleAddLink(e) {
    e.preventDefault();
    if (!linkUrl.trim()) return;
    setLinking(true);
    setError(null);
    try {
      const updated = await addLinkedPR(owner, repo, prNumber, linkUrl.trim());
      setPr(updated);
      setLinkUrl("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLinking(false);
    }
  }

  async function handleRemoveLink(linkedRepo, linkedNumber) {
    setError(null);
    try {
      await removeLinkedPR(owner, repo, prNumber, linkedRepo, linkedNumber);
      setPr((prev) =>
        prev
          ? { ...prev, linkedPrs: (prev.linkedPrs ?? []).filter((k) => k !== `${linkedRepo}#${linkedNumber}`) }
          : prev
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRun() {
    setRunning(true);
    setError(null);
    try {
      const fresh = await runReview(fullRepo, prNumber, runMode);
      setReview(fresh);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  async function handleCommentUpdate(commentId, patch) {
    try {
      const updated = await patchComment(review.id, commentId, patch);
      setReview(updated);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePush() {
    setPushing(true);
    setError(null);
    setPushSuccess(null);
    const count = selectedIds.size;
    try {
      const updated = await pushReview(review.id, Array.from(selectedIds));
      setReview(updated);
      setPushSuccess(`Pushed ${count} comment${count === 1 ? "" : "s"} to GitHub.`);
      setTimeout(() => setPushSuccess(null), 5000);
    } catch (err) {
      setError(err.message);
    } finally {
      setPushing(false);
    }
  }

  function handleSelectChange(commentId, checked) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(commentId);
      else next.delete(commentId);
      return next;
    });
  }

  const pushableComments = useMemo(() => (review?.comments ?? []).filter(isPushable), [review]);
  const selectedCount = useMemo(
    () => pushableComments.filter((c) => selectedIds.has(c.id)).length,
    [pushableComments, selectedIds]
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          {fullRepo}#{prNumber}
        </h1>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          Claude's suggested review comments, inline on the diff.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {pushSuccess && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
          <span className="flex items-center gap-2">
            <CheckCircle2 size={16} className="shrink-0" />
            {pushSuccess}
          </span>
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
            >
              View on GitHub
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}

      {loading && (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 size={16} className="animate-spin" />
          Loading…
        </Card>
      )}

      {!loading && pr && (
        <Card className="flex items-start justify-between gap-4 p-4">
          <div>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
            >
              {pr.title}
              <ExternalLink size={12} className="text-zinc-400" />
            </a>
            <div className="mt-1.5">
              <DiffStat additions={pr.additions} deletions={pr.deletions} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label
              className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400"
              title={RUN_MODE_HINTS[runMode]}
            >
              Mode
              <select
                value={runMode}
                onChange={(e) => setRunMode(e.target.value)}
                disabled={running}
                className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-sm text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                <option value="diff">Diff only</option>
                <option value="curated">Local context</option>
                <option value="deep">Deep review</option>
              </select>
            </label>
            <Button onClick={handleRun} disabled={running}>
              {running ? (
                <Loader2 size={14} className="animate-spin" />
              ) : review ? (
                <RotateCcw size={14} />
              ) : (
                <Play size={14} />
              )}
              {running ? "Running…" : review ? "Run again" : "Run review"}
            </Button>
          </div>
        </Card>
      )}

      {!loading && pr && (
        <Card className="flex flex-col gap-2.5 p-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <Link2 size={12} />
            Linked PRs
          </div>
          {(pr.linkedPrs ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pr.linkedPrs.map((key) => {
                const linked = parseLinkedKey(key);
                return (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 py-1 pl-2.5 pr-1.5 font-mono text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {linked.repo}#{linked.number}
                    <button
                      onClick={() => handleRemoveLink(linked.repo, linked.number)}
                      title="Remove link"
                      className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-red-600 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                    >
                      <X size={11} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <form className="flex gap-2" onSubmit={handleAddLink}>
            <Input
              type="url"
              className="flex-1"
              placeholder="https://github.com/owner/repo/pull/123 (dependent/related PR)"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
            />
            <Button type="submit" disabled={linking}>
              {linking ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {linking ? "Linking…" : "Link PR"}
            </Button>
          </form>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Linked PRs (e.g. the backend PR a frontend change depends on) are fed to Claude as extra context the next time you run a review, so it can check cross-PR consistency.
          </p>
        </Card>
      )}

      {running && (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 size={16} className="animate-spin" />
          {runMode === "deep"
            ? "Asking Claude to review the diff and the surrounding codebase — this can take a few minutes…"
            : runMode === "curated"
              ? "Gathering related local context and asking Claude to review the diff — this can take a minute…"
              : "Asking Claude to review the diff — this can take a minute…"}
        </Card>
      )}

      {!running && review?.summary && reviewMode === "inline" && (
        <Card className="flex items-start gap-3 p-4">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Summary of changes
              </h2>
              {parseSummary(review.summary).verdict && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${VERDICT_STYLES[parseSummary(review.summary).verdict]}`}
                >
                  {parseSummary(review.summary).verdict}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              {parseSummary(review.summary).text}
            </p>
          </div>
        </Card>
      )}

      {!running && review && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {review.comments.length} comment{review.comments.length === 1 ? "" : "s"}
              {review.withCodebaseContext && <Badge variant="reviewed">Codebase-aware</Badge>}
            </h2>
            {(() => {
              const usage = review.usage ?? {
                costUsd: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              };
              return (
                <span
                  title={
                    review.usage
                      ? `Input: ${usage.inputTokens.toLocaleString()} · Output: ${usage.outputTokens.toLocaleString()} · Cache read: ${usage.cacheReadInputTokens.toLocaleString()} · Cache creation: ${usage.cacheCreationInputTokens.toLocaleString()}`
                      : "Usage wasn't tracked for this review (run before usage tracking was added)"
                  }
                  className="text-xs text-zinc-400 dark:text-zinc-500"
                >
                {formatTokenCount(totalTokens(usage))} tokens
                </span>
              );
            })()}
            {pushableComments.length > 0 && (
              <button
                onClick={() =>
                  setSelectedIds(
                    selectedCount === pushableComments.length
                      ? new Set()
                      : new Set(pushableComments.map((c) => c.id))
                  )
                }
                className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {selectedCount === pushableComments.length ? "Deselect all" : "Select all"}
              </button>
            )}
            <div className="flex items-center gap-1 rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
              <button
                onClick={() => setReviewMode("inline")}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  reviewMode === "inline"
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                <PanelLeft size={12} />
                Inline on diff
              </button>
              <button
                onClick={() => setReviewMode("writeup")}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  reviewMode === "writeup"
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                <Sparkles size={12} />
                PR review
              </button>
              <button
                onClick={() => setReviewMode("checklist")}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  reviewMode === "checklist"
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                <ListChecks size={12} />
                PR checklist
              </button>
            </div>
          </div>
          <Button
            onClick={handlePush}
            disabled={pushing || selectedCount === 0}
            title={selectedCount === 0 ? "Select at least one comment to push" : undefined}
          >
            {pushing ? <Loader2 size={14} className="animate-spin" /> : null}
            {pushing ? "Pushing…" : `Push ${selectedCount} comment${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}

      {!running && review && reviewMode === "writeup" && (
        <PrReviewWriteup
          review={review}
          onCommentUpdate={handleCommentUpdate}
          selectedIds={selectedIds}
          onSelectChange={handleSelectChange}
        />
      )}

      {!running && review && reviewMode === "checklist" && <PrChecklist review={review} />}

      {!running && !loading && reviewMode === "inline" && files.length > 0 && (
        <>
          <button
            onClick={() => setTreeOpen((o) => !o)}
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <PanelLeft size={14} />
            {treeOpen ? "Hide" : "Show"} file tree ({files.length} file{files.length === 1 ? "" : "s"})
          </button>

          <div className="flex items-start gap-4">
            {treeOpen && (
              <div className="sticky top-4 w-64 shrink-0">
                <FileTree
                  tree={fileTree}
                  activePath={activeFile}
                  onSelectFile={handleSelectFile}
                  commentCountForFile={matcher.commentCountForFile}
                />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <DiffView
                files={files}
                matcher={matcher}
                onCommentUpdate={handleCommentUpdate}
                selectedIds={selectedIds}
                onSelectChange={handleSelectChange}
                owner={owner}
                repo={repo}
                number={number}
              />
            </div>
          </div>
        </>
      )}

      {!running && review && reviewMode === "inline" && matcher.unmatched.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Other comments
          </h2>
          <p className="-mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            These reference a line the diff view couldn't place (e.g. from a stale review).
          </p>
          {matcher.unmatched.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              onUpdate={(patch) => handleCommentUpdate(comment.id, patch)}
              selected={selectedIds.has(comment.id)}
              onSelectChange={(checked) => handleSelectChange(comment.id, checked)}
            />
          ))}
        </div>
      )}

      {!running && review && reviewMode === "inline" && review.comments.length === 0 && (
        <Card className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Claude didn't flag anything in this diff.
        </Card>
      )}

      {!running && !loading && !review && (
        <Card className="flex flex-col items-center justify-center gap-1 p-10 text-center">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No review yet</p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Run a review to get Claude's suggestions on this PR.
          </p>
        </Card>
      )}
    </div>
  );
}
