import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronRight,
  ExternalLink,
  GitPullRequestArrow,
  Inbox,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { fetchPRs, addPR, removePR, batchReviewRepo } from "../api";
import { getCachedPrs, setCachedPrs } from "../lib/prsCache";
import { DiffStat } from "../components/DiffStat";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Segmented } from "../components/ui/Segmented";
import { Skeleton } from "../components/ui/Skeleton";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";

// Groups PRs by repo, ordering the groups themselves by repo name descending (Z-A).
function groupByRepo(prs) {
  const byRepo = new Map();
  for (const pr of prs) {
    if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
    byRepo.get(pr.repo).push(pr);
  }
  return [...byRepo.entries()]
    .map(([repo, repoPrs]) => ({ repo, prs: repoPrs }))
    .sort((a, b) => b.repo.localeCompare(a.repo));
}

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "unreviewed", label: "Unreviewed" },
  { value: "reviewed", label: "Reviewed" },
  { value: "commented", label: "Commented" },
];

// Relative time reads faster than a date when scanning a queue for what's gone stale.
function relativeTime(iso) {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString();
}

function LoadingRows() {
  return (
    <Card className="flex flex-col gap-3 p-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4" style={{ opacity: 1 - i * 0.18 }}>
          <Skeleton className="size-4 rounded-md" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </Card>
  );
}

export function AssignedPRs() {
  const navigate = useNavigate();
  const [prs, setPrs] = useState(getCachedPrs() ?? []);
  const [loading, setLoading] = useState(getCachedPrs() === null);
  const [error, setError] = useState(null);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState(new Set());
  const [selectedForBatch, setSelectedForBatch] = useState(new Set());
  const [batchingRepo, setBatchingRepo] = useState(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  function load() {
    setLoading(true);
    setError(null);
    fetchPRs()
      .then((data) => {
        setCachedPrs(data);
        setPrs(data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  // Auto-fetch only on the very first load of this session — a later
  // navigation back to this page reuses the cache; use Refresh to re-fetch.
  useEffect(() => {
    if (getCachedPrs() === null) load();
  }, []);

  // Search and status narrow the list before grouping, so a repo with no
  // matches drops out of the accordion entirely instead of rendering empty.
  const visiblePrs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prs.filter((pr) => {
      if (statusFilter !== "all" && pr.status !== statusFilter) return false;
      if (!q) return true;
      return (
        pr.title.toLowerCase().includes(q) ||
        pr.repo.toLowerCase().includes(q) ||
        pr.author.toLowerCase().includes(q) ||
        String(pr.number).includes(q)
      );
    });
  }, [prs, query, statusFilter]);

  const repoGroups = useMemo(() => groupByRepo(visiblePrs), [visiblePrs]);
  const filtering = query.trim() !== "" || statusFilter !== "all";

  const counts = useMemo(
    () => ({
      total: prs.length,
      repos: new Set(prs.map((p) => p.repo)).size,
      unreviewed: prs.filter((p) => p.status === "unreviewed").length,
    }),
    [prs]
  );

  // Collapsed by default so the user expands only what they need — but only on the
  // very first load: a later refresh shouldn't re-collapse groups they've opened.
  const didInitCollapse = useRef(false);
  useEffect(() => {
    if (!didInitCollapse.current && repoGroups.length > 0) {
      didInitCollapse.current = true;
      setCollapsedRepos(new Set(repoGroups.map((g) => g.repo)));
    }
  }, [repoGroups]);

  // While a search is active, showing collapsed groups would hide the very
  // matches the user is looking for — so filtering implies expanded.
  function isCollapsed(repo) {
    return !filtering && collapsedRepos.has(repo);
  }

  function toggleRepo(repo) {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  function prKey(pr) {
    return `${pr.repo}#${pr.number}`;
  }

  function toggleSelectForBatch(pr) {
    setSelectedForBatch((prev) => {
      const next = new Set(prev);
      const key = prKey(pr);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // One repo per batch, diff-only (no deep-review toggle here) — keeps a multi-PR
  // action predictable in cost/time rather than a free-for-all across repos.
  async function handleBatchReview(repo, repoPrs) {
    const numbers = repoPrs.filter((pr) => selectedForBatch.has(prKey(pr))).map((pr) => pr.number);
    if (numbers.length === 0) return;
    setBatchingRepo(repo);
    setError(null);
    try {
      const { results } = await batchReviewRepo(repo, numbers);
      const failed = results.filter((r) => r.status === "error");
      if (failed.length > 0) {
        setError(
          `Batch review for ${repo}: ${failed.length} of ${numbers.length} failed (${failed
            .map((f) => `#${f.number}`)
            .join(", ")})`
        );
      }
      setSelectedForBatch((prev) => {
        const next = new Set(prev);
        numbers.forEach((n) => next.delete(`${repo}#${n}`));
        return next;
      });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBatchingRepo(null);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await addPR(url.trim());
      setUrl("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(pr) {
    try {
      await removePR(pr.repo, pr.number);
      setPrs((prev) => {
        const next = prev.filter((p) => !(p.repo === pr.repo && p.number === pr.number));
        setCachedPrs(next);
        return next;
      });
    } catch (err) {
      setError(err.message);
    }
  }

  const allCollapsed = collapsedRepos.size === repoGroups.length && repoGroups.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Review queue"
        icon={GitPullRequestArrow}
        title="Pull requests waiting on you"
        description="Open PRs where GitHub has requested your review, plus anything you've added by URL."
        actions={
          <>
            {repoGroups.length > 0 && (
              <Button
                variant="ghost"
                onClick={() =>
                  setCollapsedRepos(allCollapsed ? new Set() : new Set(repoGroups.map((g) => g.repo)))
                }
              >
                {allCollapsed ? "Expand all" : "Collapse all"}
              </Button>
            )}
            <Button variant="secondary" onClick={load} disabled={loading} title="Re-fetch from GitHub">
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Refresh
            </Button>
          </>
        }
      />

      {/* Queue vitals — the shape of the workload before any row is read. */}
      {prs.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {[
            { label: "open", value: counts.total },
            { label: counts.repos === 1 ? "repo" : "repos", value: counts.repos },
            { label: "unreviewed", value: counts.unreviewed, accent: true },
          ].map((chip) => (
            <span
              key={chip.label}
              className={`inline-flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1 text-xs ${
                chip.accent ? "bg-brand/8 text-ink" : "bg-surface-2 text-muted"
              }`}
            >
              <span className="font-bold tabular-nums">{chip.value}</span>
              {chip.label}
            </span>
          ))}
        </div>
      )}

      {/* Controls: add by URL, search, status */}
      <Card className="flex flex-col gap-3 p-4">
        <form className="flex flex-wrap gap-2" onSubmit={handleAdd}>
          <Input
            type="url"
            className="min-w-64 flex-1"
            placeholder="https://github.com/owner/repo/pull/123"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={adding}>
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {adding ? "Adding…" : "Add PR"}
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          <div className="relative min-w-56 flex-1">
            <Search size={14} className="absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <Input
              type="search"
              className="w-full pl-9"
              placeholder="Filter by title, repo, author or number…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Segmented
            options={STATUS_FILTERS}
            value={statusFilter}
            onChange={setStatusFilter}
            size="sm"
          />
        </div>
      </Card>

      {error && (
        <div className="flex animate-slide-down items-start gap-2.5 rounded-xl border border-bad/25 bg-bad/8 px-3.5 py-2.5 text-sm text-bad">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading && <LoadingRows />}

      {!loading && prs.length === 0 && !error && (
        <EmptyState
          icon={Inbox}
          title="Nothing here yet"
          description="No open PRs currently need your review, and none have been added manually."
        />
      )}

      {!loading && prs.length > 0 && repoGroups.length === 0 && (
        <EmptyState
          icon={Search}
          title="No matches"
          description="Nothing in the queue matches that filter."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}

      {!loading &&
        repoGroups.map(({ repo, prs: repoPrs }, groupIndex) => {
          const collapsed = isCollapsed(repo);
          const selectedCount = repoPrs.filter((pr) => selectedForBatch.has(prKey(pr))).length;
          const isBatching = batchingRepo === repo;

          return (
            <Card
              key={repo}
              className="animate-fade-up overflow-hidden p-0"
              style={{ animationDelay: `${Math.min(groupIndex, 6) * 60}ms` }}
            >
              <div className="flex items-center justify-between gap-3 border-b border-hairline bg-surface-2/70 px-4 py-3 backdrop-blur">
                <button
                  onClick={() => toggleRepo(repo)}
                  className="group flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  aria-expanded={!collapsed}
                >
                  <ChevronRight
                    size={15}
                    className={`shrink-0 text-faint transition-transform duration-300 group-hover:text-brand ${
                      collapsed ? "" : "rotate-90"
                    }`}
                  />
                  <span className="truncate font-mono text-sm font-semibold text-ink">{repo}</span>
                  <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted ring-1 ring-hairline ring-inset">
                    {repoPrs.length}
                  </span>
                </button>
                <Button
                  variant={selectedCount > 0 ? "subtle" : "ghost"}
                  size="sm"
                  disabled={selectedCount === 0 || (batchingRepo != null && !isBatching)}
                  onClick={() => handleBatchReview(repo, repoPrs)}
                  title={selectedCount === 0 ? "Select PRs below to batch review" : undefined}
                >
                  {isBatching ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  {isBatching ? "Reviewing…" : `Batch review${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
                </Button>
              </div>

              <div className={`collapsible ${collapsed ? "" : "open"}`}>
                <div>
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-hairline text-left text-[10px] font-bold tracking-[0.12em] text-faint uppercase">
                        <th className="w-10 py-2.5 pl-4" />
                        <th className="px-3 py-2.5 font-bold">Pull request</th>
                        <th className="px-3 py-2.5 font-bold">Author</th>
                        <th className="px-3 py-2.5 font-bold">Updated</th>
                        <th className="px-3 py-2.5 font-bold">Diff</th>
                        <th className="px-3 py-2.5 font-bold">Source</th>
                        <th className="px-3 py-2.5 font-bold">Status</th>
                        <th className="py-2.5 pr-4" />
                      </tr>
                    </thead>
                    <tbody>
                      {repoPrs.map((pr) => {
                        const selected = selectedForBatch.has(prKey(pr));
                        return (
                          <tr
                            key={prKey(pr)}
                            className={`group relative border-b border-hairline transition-colors duration-200 last:border-0 hover:bg-surface-2/60 ${
                              selected ? "bg-brand/5" : ""
                            }`}
                          >
                            <td className="py-3 pl-4 align-top">
                              {/* Selection rail doubles as the row's hover accent. */}
                              <span
                                aria-hidden
                                className={`absolute inset-y-0 left-0 w-[3px] bg-linear-to-b from-brand-2 to-brand-3 transition-transform duration-300 ${
                                  selected ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"
                                }`}
                              />
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => toggleSelectForBatch(pr)}
                                title="Select for batch review"
                                className="size-3.5 accent-[var(--brand)]"
                              />
                            </td>
                            <td className="max-w-md px-3 py-3 align-top">
                              <a
                                href={pr.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 font-semibold text-ink transition-colors hover:text-brand"
                              >
                                #{pr.number}
                                <ExternalLink size={11} className="text-faint" />
                              </a>
                              <div className="mt-0.5 truncate text-xs text-muted">{pr.title}</div>
                            </td>
                            <td className="px-3 py-3 align-top text-xs text-muted">{pr.author}</td>
                            <td
                              className="px-3 py-3 align-top text-xs whitespace-nowrap text-muted"
                              title={new Date(pr.updatedAt).toLocaleString()}
                            >
                              {relativeTime(pr.updatedAt)}
                            </td>
                            <td className="px-3 py-3 align-top">
                              <DiffStat additions={pr.additions} deletions={pr.deletions} />
                            </td>
                            <td className="px-3 py-3 align-top">
                              <Badge variant={pr.source}>{pr.source}</Badge>
                            </td>
                            <td className="px-3 py-3 align-top">
                              <Badge variant={pr.status}>{pr.status}</Badge>
                            </td>
                            <td className="py-3 pr-4 align-top">
                              <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="opacity-70 transition-opacity group-hover:opacity-100"
                                  onClick={() => {
                                    const [prOwner, prRepo] = pr.repo.split("/");
                                    navigate(`/review/${prOwner}/${prRepo}/${pr.number}`);
                                  }}
                                >
                                  Review
                                  <ChevronRight size={13} />
                                </Button>
                                {pr.source === "manual" && (
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    onClick={() => handleRemove(pr)}
                                    title="Remove"
                                  >
                                    <Trash2 size={13} />
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          );
        })}
    </div>
  );
}
