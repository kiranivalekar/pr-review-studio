import { Router } from "express";
import {
  getAuthenticatedLogin,
  searchReviewRequestedOpenPRs,
  getPR,
  getPRDiff,
  getFileContent,
  normalizePR,
  parsePRUrl,
  repoOwnerFromUrl,
} from "../github.js";
import { readDB, upsertPR, deletePR, computeStatus } from "../db.js";
import { mapWithConcurrency } from "../concurrency.js";

export const router = Router();

function withStatus(pr, db) {
  return { ...pr, status: computeStatus(pr.repo, pr.number, db) };
}

router.get("/prs", async (req, res, next) => {
  try {
    const login = await getAuthenticatedLogin();
    const searchResults = await searchReviewRequestedOpenPRs(login);

    const assignedKeys = new Set();
    await mapWithConcurrency(searchResults, 8, async (item) => {
      const { owner, repo } = repoOwnerFromUrl(item.repository_url);
      if (!owner || !repo) return;
      try {
        const full = await getPR(owner, repo, item.number);
        const pr = normalizePR(full, { owner, repo, source: "assigned" });
        upsertPR(pr);
        assignedKeys.add(`${owner}/${repo}#${item.number}`);
      } catch (err) {
        console.error(`Failed to refresh assigned PR ${owner}/${repo}#${item.number}:`, err.message);
      }
    });

    // Refresh manually-added PRs not covered by the assigned fetch above.
    const dbBefore = readDB();
    const manualEntries = Object.entries(dbBefore.prs).filter(
      ([key, pr]) => pr.source === "manual" && !assignedKeys.has(key)
    );
    await mapWithConcurrency(manualEntries, 8, async ([key, pr]) => {
      const [owner, repo] = pr.repo.split("/");
      try {
        const full = await getPR(owner, repo, pr.number);
        upsertPR(normalizePR(full, { owner, repo, source: "manual" }));
      } catch (err) {
        console.error(`Failed to refresh manual PR ${key}, keeping stale copy:`, err.message);
      }
    });

    // Drop assigned PRs that are no longer open+review-requested (closed, merged, or
    // review no longer needed) — otherwise they'd linger in the db forever since only
    // currently-returned search results get upserted, never pruned.
    for (const [key, pr] of Object.entries(dbBefore.prs)) {
      if (pr.source === "assigned" && !assignedKeys.has(key)) {
        deletePR(pr.repo, pr.number);
      }
    }

    const db = readDB();
    const list = Object.values(db.prs)
      .filter((pr) => pr.state == null || pr.state === "open")
      .map((pr) => withStatus(pr, db))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.post("/added-prs", async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }
    const { owner, repo, number } = parsePRUrl(url);
    const full = await getPR(owner, repo, number);
    const pr = upsertPR(normalizePR(full, { owner, repo, source: "manual" }));
    res.status(201).json(withStatus(pr, readDB()));
  } catch (err) {
    next(err);
  }
});

router.get("/prs/:owner/:repo/:number/diff", async (req, res, next) => {
  try {
    const { owner, repo, number } = req.params;
    const diff = await getPRDiff(owner, repo, number);
    res.type("text/plain").send(diff);
  } catch (err) {
    next(err);
  }
});

router.get("/prs/:owner/:repo/:number/file", async (req, res, next) => {
  try {
    const { owner, repo, number } = req.params;
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: "path query param is required" });
    const pr = await getPR(owner, repo, number);
    const content = await getFileContent(owner, repo, path, pr.head.sha);
    res.type("text/plain").send(content);
  } catch (err) {
    next(err);
  }
});

router.delete("/added-prs/:owner/:repo/:number", (req, res) => {
  const { owner, repo, number } = req.params;
  deletePR(`${owner}/${repo}`, Number(number));
  res.status(204).end();
});
