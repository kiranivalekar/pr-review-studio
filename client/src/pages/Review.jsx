import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Gauge,
  Layers,
  Link2,
  ListChecks,
  Loader2,
  MessageSquareCode,
  PanelLeft,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Telescope,
  TriangleAlert,
  Upload,
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
import { Segmented } from "../components/ui/Segmented";
import { Skeleton } from "../components/ui/Skeleton";
import { EmptyState } from "../components/ui/EmptyState";
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

const RUN_MODES = [
  {
    value: "diff",
    label: "Diff only",
    icon: Gauge,
    hint: "Fastest and cheapest — reviews just the diff, no local codebase access.",
  },
  {
    value: "curated",
    label: "Local context",
    icon: Layers,
    hint: "Checks out the PR locally and pastes bounded snippets of files that reference the diff's changes into one prompt — more context than diff-only, without the slower/costlier interactive exploration Deep review does.",
  },
  {
    value: "deep",
    label: "Deep review",
    icon: Telescope,
    hint: "Checks out the PR locally and lets Claude interactively read the surrounding codebase (Read/Grep/Glob) — most thorough, but slowest and most expensive.",
  },
];

const RUNNING_COPY = {
  diff: "Asking Claude to review the diff — this can take a minute…",
  curated: "Gathering related local context and asking Claude to review the diff — this can take a minute…",
  deep: "Asking Claude to review the diff and the surrounding codebase — this can take a few minutes…",
};

const VIEW_MODES = [
  { value: "inline", label: "Inline on diff", icon: MessageSquareCode },
  { value: "writeup", label: "PR review", icon: Sparkles },
  { value: "checklist", label: "PR checklist", icon: ListChecks },
];

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
  const summary = useMemo(() => (review?.summary ? parseSummary(review.summary) : null), [review]);
  const usage = review?.usage ?? null;

  return (
    <div className="flex flex-col gap-5">
      {/* ---------- header ---------- */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/prs"
            className="group inline-flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={13} className="transition-transform duration-300 group-hover:-translate-x-0.5" />
            Review queue
          </Link>
          <h1 className="mt-1.5 flex flex-wrap items-center gap-2.5 text-2xl font-bold tracking-[-0.02em] text-ink">
            <span className="font-mono">
              {fullRepo}
              <span className="text-brand">#{prNumber}</span>
            </span>
            {pr && <Badge variant={pr.status}>{pr.status}</Badge>}
          </h1>
          {pr ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
            >
              {pr.title}
              <ExternalLink size={12} className="text-faint" />
            </a>
          ) : (
            <p className="mt-1 text-sm text-muted">Claude's suggested comments, inline on the diff.</p>
          )}
        </div>

        {pr && (
          <div className="flex items-center gap-3">
            <DiffStat additions={pr.additions} deletions={pr.deletions} />
          </div>
        )}
      </header>

      {/* ---------- run controls ---------- */}
      {!loading && pr && (
        <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="text-[11px] font-bold tracking-[0.14em] text-faint uppercase">Depth</span>
            <Segmented
              options={RUN_MODES}
              value={runMode}
              onChange={setRunMode}
              className={running ? "pointer-events-none opacity-50" : ""}
            />
            <p className="max-w-md text-xs leading-relaxed text-faint">
              {RUN_MODES.find((m) => m.value === runMode)?.hint}
            </p>
          </div>
          <Button variant="primary" onClick={handleRun} disabled={running}>
            {running ? (
              <Loader2 size={15} className="animate-spin" />
            ) : review ? (
              <RotateCcw size={15} />
            ) : (
              <Play size={15} />
            )}
            {running ? "Running…" : review ? "Run again" : "Run review"}
          </Button>
        </Card>
      )}

      {/* ---------- linked PRs ---------- */}
      {!loading && pr && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-faint uppercase">
            <Link2 size={12} className="text-brand" />
            Linked PRs
          </div>

          {(pr.linkedPrs ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pr.linkedPrs.map((key) => {
                const linked = parseLinkedKey(key);
                return (
                  <span
                    key={key}
                    className="inline-flex animate-scale-in items-center gap-1.5 rounded-full border border-hairline bg-surface-2 py-1 pr-1.5 pl-2.5 font-mono text-xs font-medium text-ink"
                  >
                    {linked.repo}#{linked.number}
                    <button
                      onClick={() => handleRemoveLink(linked.repo, linked.number)}
                      title="Remove link"
                      className="rounded-full p-0.5 text-faint transition-colors hover:bg-bad/10 hover:text-bad"
                    >
                      <X size={11} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <form className="flex flex-wrap gap-2" onSubmit={handleAddLink}>
            <Input
              type="url"
              className="min-w-64 flex-1"
              placeholder="https://github.com/owner/repo/pull/123 (dependent/related PR)"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={linking}>
              {linking ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {linking ? "Linking…" : "Link PR"}
            </Button>
          </form>
          <p className="text-xs leading-relaxed text-faint">
            Linked PRs (e.g. the backend PR a frontend change depends on) are fed to Claude as extra
            context the next time you run a review, so it can check cross-PR consistency.
          </p>
        </Card>
      )}

      {/* ---------- transient state ---------- */}
      {error && (
        <div className="flex animate-slide-down items-start gap-2.5 rounded-xl border border-bad/25 bg-bad/8 px-3.5 py-2.5 text-sm text-bad">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {pushSuccess && (
        <div className="flex animate-slide-down items-center justify-between gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3.5 py-2.5 text-sm text-emerald-600 dark:text-emerald-300">
          <span className="flex items-center gap-2">
            <CheckCircle2 size={16} className="shrink-0" />
            {pushSuccess}
          </span>
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 font-semibold hover:underline"
            >
              View on GitHub
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}

      {loading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      )}

      {running && (
        <Card className="relative flex flex-col items-center gap-3 overflow-hidden px-6 py-14 text-center">
          {/* Indeterminate progress — the CLI gives no percentage to report. */}
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-0.5 animate-shimmer bg-[linear-gradient(90deg,transparent,var(--brand),transparent)] bg-[length:50%_100%]"
          />
          <span className="relative grid size-12 place-items-center rounded-2xl border border-hairline bg-surface-2 text-brand">
            <span aria-hidden className="absolute inset-0 animate-pulse-dot rounded-2xl bg-brand/20 blur-lg" />
            <Sparkles size={20} className="relative animate-pulse" />
          </span>
          <p className="max-w-sm text-sm text-muted">{RUNNING_COPY[runMode]}</p>
        </Card>
      )}

      {/* ---------- review summary ---------- */}
      {!running && summary && reviewMode === "inline" && (
        <Card className="flex animate-fade-up items-start gap-3 p-4">
          <span className="mt-0.5 shrink-0 text-brand">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[11px] font-bold tracking-[0.14em] text-faint uppercase">
                Summary of changes
              </h2>
              {summary.verdict && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${VERDICT_STYLES[summary.verdict]}`}
                >
                  {summary.verdict}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink">{summary.text}</p>
          </div>
        </Card>
      )}

      {/* ---------- sticky action bar ---------- */}
      {!running && review && (
        <div className="sticky top-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-hairline bg-surface/80 px-3 py-2.5 shadow-[var(--shadow-card)] backdrop-blur-xl">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink">
              {review.comments.length} comment{review.comments.length === 1 ? "" : "s"}
              {review.withCodebaseContext && <Badge variant="brand">Codebase-aware</Badge>}
            </span>

            <span
              title={
                usage
                  ? `Input: ${usage.inputTokens.toLocaleString()} · Output: ${usage.outputTokens.toLocaleString()} · Cache read: ${usage.cacheReadInputTokens.toLocaleString()} · Cache creation: ${usage.cacheCreationInputTokens.toLocaleString()}`
                  : "Usage wasn't tracked for this review (run before usage tracking was added)"
              }
              className="text-xs text-faint tabular-nums"
            >
              {formatTokenCount(totalTokens(usage ?? {}))} tokens
            </span>

            {pushableComments.length > 0 && (
              <button
                onClick={() =>
                  setSelectedIds(
                    selectedCount === pushableComments.length
                      ? new Set()
                      : new Set(pushableComments.map((c) => c.id))
                  )
                }
                className="text-xs font-semibold text-brand transition-opacity hover:opacity-75"
              >
                {selectedCount === pushableComments.length ? "Deselect all" : "Select all"}
              </button>
            )}

            <Segmented options={VIEW_MODES} value={reviewMode} onChange={setReviewMode} size="sm" />
          </div>

          <Button
            variant="primary"
            onClick={handlePush}
            disabled={pushing || selectedCount === 0}
            title={selectedCount === 0 ? "Select at least one comment to push" : undefined}
          >
            {pushing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
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

      {/* ---------- diff ---------- */}
      {!running && !loading && reviewMode === "inline" && files.length > 0 && (
        <>
          <button
            onClick={() => setTreeOpen((o) => !o)}
            className="inline-flex w-fit items-center gap-1.5 text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            <PanelLeft size={14} className={`transition-transform duration-300 ${treeOpen ? "" : "rotate-180"}`} />
            {treeOpen ? "Hide" : "Show"} file tree ({files.length} file{files.length === 1 ? "" : "s"})
          </button>

          <div className="flex items-start gap-4">
            {treeOpen && (
              <div className="sticky top-24 w-64 shrink-0 animate-fade-up">
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

      {/* ---------- comments the diff couldn't place ---------- */}
      {!running && review && reviewMode === "inline" && matcher.unmatched.length > 0 && (
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Other comments</h2>
            <p className="mt-0.5 text-xs text-faint">
              These reference a line the diff view couldn't place (e.g. from a stale review).
            </p>
          </div>
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
        <EmptyState
          icon={CheckCircle2}
          title="Nothing flagged"
          description="Claude didn't find anything worth commenting on in this diff."
        />
      )}

      {!running && !loading && !review && (
        <EmptyState
          icon={Sparkles}
          title="No review yet"
          description="Pick a depth above and run a review to get Claude's suggestions on this PR."
          action={
            <Button variant="primary" onClick={handleRun} disabled={running}>
              <Play size={15} />
              Run review
            </Button>
          }
        />
      )}
    </div>
  );
}
