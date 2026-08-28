import { Router } from "express";
import { getPR, getPRDiff, createPullRequestReview } from "../github.js";
import { runReview } from "../claude.js";
import { findLocalRepo, prepareReviewWorktree, cleanupReviewWorktree } from "../localRepo.js";
import { createReview, listReviews, getReview, updateComment } from "../db.js";
import { mapWithConcurrency } from "../concurrency.js";

export const router = Router();

async function runReviewWithCodebaseContext(owner, name, number, diff) {
  const repoPath = findLocalRepo(name);
  if (!repoPath) return { ...(await runReview(diff)), withCodebaseContext: false };

  let worktreeDir;
  try {
    const pr = await getPR(owner, name, number);
    worktreeDir = await prepareReviewWorktree(repoPath, { owner, repoName: name, number, headSha: pr.head.sha });
    const result = await runReview(diff, { cwd: worktreeDir });
    return { ...result, withCodebaseContext: true };
  } catch (err) {
    console.warn(`Codebase-aware review failed for ${owner}/${name}#${number}, falling back to diff-only:`, err.message);
    return { ...(await runReview(diff)), withCodebaseContext: false };
  } finally {
    if (worktreeDir) await cleanupReviewWorktree(repoPath, worktreeDir).catch(() => {});
  }
}

const SEVERITY_EMOJI = { blocking: "🚫", issue: "⚠️", suggestion: "💡", nit: "💬" };

// GitHub renders a ```suggestion fenced block as a real "Apply suggestion" button,
// so this is a genuine upgrade over embedding the replacement as a plain code block.
function formatInlineBody(c) {
  const suggestion = c.suggestion ? `\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\`` : "";
  return `${SEVERITY_EMOJI[c.severity] ?? ""} **${c.severity}**\n\n${c.text}${suggestion}`;
}

// Comments Claude couldn't tie to a specific diff line (line === null) can't be
// posted as inline review comments — GitHub requires path+line for those — so they
// go in the review's overall body instead of being silently dropped.
function formatUnplaced(comments) {
  return comments
    .map((c) => `### ${SEVERITY_EMOJI[c.severity] ?? ""} ${c.severity} — \`${c.file}\`\n${c.text}`)
    .join("\n\n---\n\n");
}

router.post("/reviews/:id/push", async (req, res, next) => {
  try {
    const review = getReview(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });

    const { commentIds } = req.body ?? {};
    const eligible = review.comments.filter((c) => c.state !== "dismissed" && c.state !== "pushed");
    const toPush = Array.isArray(commentIds)
      ? eligible.filter((c) => commentIds.includes(c.id))
      : eligible;
    if (toPush.length === 0) {
      return res.status(400).json({ error: "No comments selected to push" });
    }

    const [owner, name] = review.repo.split("/");
    const pr = await getPR(owner, name, review.number);

    const inline = toPush.filter((c) => c.line != null);
    const unplaced = toPush.filter((c) => c.line == null);

    const comments = inline.map((c) => ({
      path: c.file,
      line: c.line,
      side: c.side === "LEFT" ? "LEFT" : "RIGHT",
      body: formatInlineBody(c),
    }));
    // No placeholder text when everything landed inline — an empty/omitted body just
    // shows the line comments themselves, with no extra "review" label above them.
    const body = unplaced.length > 0
      ? `Comments that couldn't be attached to a specific line:\n\n${formatUnplaced(unplaced)}`
      : undefined;

    await createPullRequestReview(owner, name, review.number, { commitId: pr.head.sha, body, comments });

    const pushedAt = new Date().toISOString();
    let updated = review;
    for (const c of toPush) {
      updated = updateComment(review.id, c.id, { state: "pushed", pushedAt });
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

async function runAndStoreReview(repo, number, deepReview) {
  const [owner, name] = repo.split("/");
  const diff = await getPRDiff(owner, name, number);
  const { summary, comments, withCodebaseContext } = deepReview
    ? await runReviewWithCodebaseContext(owner, name, number, diff)
    : { ...(await runReview(diff)), withCodebaseContext: false };

  const review = {
    id: `review_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    repo,
    number: Number(number),
    createdAt: new Date().toISOString(),
    model: "claude-sonnet-5",
    withCodebaseContext,
    summary: summary || "",
    comments: comments.map((c, i) => ({
      id: `c${i + 1}`,
      ...c,
      state: "suggested",
      pushedAt: null,
    })),
  };
  createReview(review);
  return review;
}

router.post("/review", async (req, res, next) => {
  try {
    const { repo, number, deepReview } = req.body;
    if (!repo || !number) {
      return res.status(400).json({ error: "repo and number are required" });
    }
    const review = await runAndStoreReview(repo, number, deepReview);
    res.status(201).json(review);
  } catch (err) {
    next(err);
  }
});

// One repo per batch by design (matches the Assigned PRs accordion, grouped by repo) —
// diff-only only, no deep-review option here, to keep a multi-PR action predictable in
// cost/time. Concurrency capped at 3: each review spawns a real `claude` CLI process,
// heavier than the plain GitHub GETs the PR-list refresh bounds at 8.
router.post("/reviews/batch", async (req, res, next) => {
  try {
    const { repo, numbers } = req.body;
    if (!repo || !Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: "repo and a non-empty numbers array are required" });
    }
    const results = new Array(numbers.length);
    await mapWithConcurrency(numbers, 3, async (number, i) => {
      try {
        const review = await runAndStoreReview(repo, number, false);
        results[i] = { number, status: "ok", reviewId: review.id };
      } catch (err) {
        results[i] = { number, status: "error", error: err.message };
      }
    });
    res.status(201).json({ results });
  } catch (err) {
    next(err);
  }
});

router.get("/reviews", (req, res) => {
  const { repo, number, state } = req.query;
  res.json(listReviews({ repo, number, state }));
});

router.get("/reviews/:id", (req, res) => {
  const review = getReview(req.params.id);
  if (!review) return res.status(404).json({ error: "Review not found" });
  res.json(review);
});

router.patch("/reviews/:id/comments/:commentId", (req, res) => {
  const { text, severity, suggestion, state } = req.body;
  const patch = {};
  if (text !== undefined) patch.text = text;
  if (severity !== undefined) patch.severity = severity;
  if (suggestion !== undefined) patch.suggestion = suggestion;
  if (state !== undefined) {
    patch.state = state;
  } else if (text !== undefined || severity !== undefined || suggestion !== undefined) {
    patch.state = "edited";
  }

  const review = updateComment(req.params.id, req.params.commentId, patch);
  if (!review) return res.status(404).json({ error: "Review or comment not found" });
  res.json(review);
});
