import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { fetchPRs, addPR, removePR, batchReviewRepo } from "../api";
import { getCachedPrs, setCachedPrs } from "../lib/prsCache";
import { DiffStat } from "../components/DiffStat";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";

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

  const repoGroups = useMemo(() => groupByRepo(prs), [prs]);

  // Collapsed by default so the user expands only what they need — but only on the
  // very first load: a later refresh shouldn't re-collapse groups they've opened.
  const didInitCollapse = useRef(false);
  useEffect(() => {
    if (!didInitCollapse.current && repoGroups.length > 0) {
      didInitCollapse.current = true;
      setCollapsedRepos(new Set(repoGroups.map((g) => g.repo)));
    }
  }, [repoGroups]);

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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Assigned PRs</h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Open PRs where your review is requested on GitHub, plus anything you've added manually.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {repoGroups.length > 0 && (
            <button
              onClick={() =>
                setCollapsedRepos(
                  collapsedRepos.size === repoGroups.length
                    ? new Set()
                    : new Set(repoGroups.map((g) => g.repo))
                )
              }
              className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {collapsedRepos.size === repoGroups.length ? "Expand all" : "Collapse all"}
            </button>
          )}
          <Button variant="ghost" onClick={load} disabled={loading} title="Refresh">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <form className="flex gap-2" onSubmit={handleAdd}>
          <Input
            type="url"
            className="flex-1"
            placeholder="https://github.com/owner/repo/pull/123"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={adding}>
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {adding ? "Adding…" : "Add PR"}
          </Button>
        </form>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && (
        <Card className="flex items-center justify-center gap-2 p-10 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 size={16} className="animate-spin" />
          Loading…
        </Card>
      )}

      {!loading && prs.length === 0 && !error && (
        <Card className="flex flex-col items-center justify-center gap-1 p-10 text-center">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing here yet</p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No open PRs currently need your review, and none added manually.
          </p>
        </Card>
      )}

      {!loading &&
        repoGroups.map(({ repo, prs: repoPrs }) => {
          const collapsed = collapsedRepos.has(repo);
          const selectedCount = repoPrs.filter((pr) => selectedForBatch.has(prKey(pr))).length;
          const isBatching = batchingRepo === repo;
          return (
            <Card key={repo} className="overflow-hidden p-0">
              <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                <button
                  onClick={() => toggleRepo(repo)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {collapsed ? (
                    <ChevronRight size={14} className="shrink-0 text-zinc-400" />
                  ) : (
                    <ChevronDown size={14} className="shrink-0 text-zinc-400" />
                  )}
                  <span className="truncate font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {repo}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                    {repoPrs.length} PR{repoPrs.length === 1 ? "" : "s"}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  disabled={selectedCount === 0 || (batchingRepo != null && !isBatching)}
                  onClick={() => handleBatchReview(repo, repoPrs)}
                  title={selectedCount === 0 ? "Select PRs below to batch review" : undefined}
                >
                  {isBatching ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {isBatching ? "Reviewing…" : `Batch review${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
                </Button>
              </div>

              {!collapsed && (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                      <th className="w-10 px-4 py-2.5" />
                      <th className="px-4 py-2.5 font-medium">PR</th>
                      <th className="px-4 py-2.5 font-medium">Author</th>
                      <th className="px-4 py-2.5 font-medium">Updated</th>
                      <th className="px-4 py-2.5 font-medium">Diff</th>
                      <th className="px-4 py-2.5 font-medium">Source</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {repoPrs.map((pr) => (
                      <tr
                        key={`${pr.repo}#${pr.number}`}
                        className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                      >
                        <td className="px-4 py-3 align-top">
                          <input
                            type="checkbox"
                            checked={selectedForBatch.has(prKey(pr))}
                            onChange={() => toggleSelectForBatch(pr)}
                            title="Select for batch review"
                            className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600"
                          />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <a
                            href={pr.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
                          >
                            #{pr.number}
                            <ExternalLink size={12} className="text-zinc-400" />
                          </a>
                          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{pr.title}</div>
                        </td>
                        <td className="px-4 py-3 align-top text-zinc-600 dark:text-zinc-400">{pr.author}</td>
                        <td className="px-4 py-3 align-top text-zinc-600 dark:text-zinc-400">
                          {new Date(pr.updatedAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <DiffStat additions={pr.additions} deletions={pr.deletions} />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <Badge variant={pr.source}>{pr.source}</Badge>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <Badge variant={pr.status}>{pr.status}</Badge>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                            <Button
                              variant="ghost"
                              onClick={() => {
                                const [prOwner, prRepo] = pr.repo.split("/");
                                navigate(`/review/${prOwner}/${prRepo}/${pr.number}`);
                              }}
                            >
                              Review
                            </Button>
                            {pr.source === "manual" && (
                              <Button variant="danger" onClick={() => handleRemove(pr)} title="Remove">
                                <Trash2 size={14} />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          );
        })}
    </div>
  );
}
