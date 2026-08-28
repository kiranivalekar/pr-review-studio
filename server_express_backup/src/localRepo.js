import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREES_ROOT = path.join(__dirname, "..", "..", "data", "worktrees");

const GIT_TIMEOUT_MS = 30_000;

// GIT_TERMINAL_PROMPT=0 + a hard kill timeout are both required: verified empirically
// that on this machine a plain `git fetch origin ...` over HTTPS with no cached
// credentials hangs waiting on an interactive credential-manager dialog rather than
// failing fast, even with terminal prompts disabled. Network calls (fetch) must use
// buildAuthedUrl() below instead of the bare "origin" remote to avoid triggering that
// credential lookup at all; the timeout is defense-in-depth for anything that still hangs.
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to launch git: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} exited with code ${code}: ${stderr || "no stderr output"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// Embeds GITHUB_TOKEN in the fetch URL so git authenticates directly against GitHub
// instead of going through the local git credential helper (see runGit comment above).
function authedFetchUrl(owner, repoName) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw Object.assign(new Error("GITHUB_TOKEN is not set"), { status: 500 });
  }
  return `https://${token}@github.com/${owner}/${repoName}.git`;
}

// Local clones are expected one subfolder per repo name under LOCAL_REPOS_ROOT
// (e.g. F:\GFS_SaaS\gfs-saas-core) — reused as-is, never cloned by this app.
export function findLocalRepo(repoName) {
  const root = process.env.LOCAL_REPOS_ROOT;
  if (!root) return null;
  const repoPath = path.join(root, repoName);
  if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
    return null;
  }
  return repoPath;
}

function worktreeDirFor(repoName, number) {
  return path.join(WORKTREES_ROOT, `${repoName}-pr${number}`);
}

// Checks out the PR's head commit into a disposable linked worktree, leaving
// the repo's own checkout (branch, uncommitted changes) untouched.
export async function prepareReviewWorktree(repoPath, { owner, repoName, number, headSha }) {
  await runGit(["fetch", authedFetchUrl(owner, repoName), `pull/${number}/head`], repoPath);

  const worktreeDir = worktreeDirFor(repoName, number);
  if (fs.existsSync(worktreeDir)) {
    try {
      await runGit(["worktree", "remove", "--force", worktreeDir], repoPath);
    } catch {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(WORKTREES_ROOT, { recursive: true });
  await runGit(["worktree", "add", "--detach", worktreeDir, headSha], repoPath);
  return worktreeDir;
}

export async function cleanupReviewWorktree(repoPath, worktreeDir) {
  try {
    await runGit(["worktree", "remove", "--force", worktreeDir], repoPath);
  } catch {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
  await runGit(["worktree", "prune"], repoPath).catch(() => {});
}
