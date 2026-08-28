import asyncio
import os
import re
import shutil
from pathlib import Path

from app.config import github_token, local_repos_root

# Two levels up from app/ lands at the project root, same as db.py.
WORKTREES_ROOT = Path(__file__).resolve().parents[2] / "data" / "worktrees"

GIT_TIMEOUT_SECONDS = 30


# GIT_TERMINAL_PROMPT=0 + a hard kill timeout are both required: verified empirically
# that on this machine a plain `git fetch origin ...` over HTTPS with no cached
# credentials hangs waiting on an interactive credential-manager dialog rather than
# failing fast, even with terminal prompts disabled. Network calls (fetch) must use
# _authed_fetch_url() below instead of the bare "origin" remote to avoid triggering that
# credential lookup at all; the timeout is defense-in-depth for anything that still hangs.
async def _run_git(args: list[str], cwd: str) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=cwd,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as err:
        raise RuntimeError(f"Failed to launch git: {err}") from err

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=GIT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"git {' '.join(args)} timed out after {GIT_TIMEOUT_SECONDS}s")

    if proc.returncode != 0:
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        raise RuntimeError(f"git {' '.join(args)} exited with code {proc.returncode}: {stderr or 'no stderr output'}")

    return stdout_bytes.decode("utf-8", errors="replace")


# Embeds GITHUB_TOKEN in the fetch URL so git authenticates directly against GitHub
# instead of going through the local git credential helper (see _run_git comment above).
def _authed_fetch_url(owner: str, repo_name: str) -> str:
    token = github_token()
    return f"https://{token}@github.com/{owner}/{repo_name}.git"


# Local clones are expected one subfolder per repo name under LOCAL_REPOS_ROOT
# (e.g. F:\GFS_SaaS\gfs-saas-core) — reused as-is, never cloned by this app.
def find_local_repo(repo_name: str) -> str | None:
    root = local_repos_root()
    if not root:
        return None
    repo_path = Path(root) / repo_name
    if not repo_path.exists() or not (repo_path / ".git").exists():
        return None
    return str(repo_path)


def _worktree_dir_for(repo_name: str, number: int | str) -> Path:
    return WORKTREES_ROOT / f"{repo_name}-pr{number}"


# Checks out the PR's head commit into a disposable linked worktree, leaving
# the repo's own checkout (branch, uncommitted changes) untouched.
async def prepare_review_worktree(repo_path: str, owner: str, repo_name: str, number: int | str, head_sha: str) -> str:
    await _run_git(["fetch", _authed_fetch_url(owner, repo_name), f"pull/{number}/head"], repo_path)

    worktree_dir = _worktree_dir_for(repo_name, number)
    if worktree_dir.exists():
        try:
            await _run_git(["worktree", "remove", "--force", str(worktree_dir)], repo_path)
        except RuntimeError:
            shutil.rmtree(worktree_dir, ignore_errors=True)

    WORKTREES_ROOT.mkdir(parents=True, exist_ok=True)
    await _run_git(["worktree", "add", "--detach", str(worktree_dir), head_sha], repo_path)
    return str(worktree_dir)


async def cleanup_review_worktree(repo_path: str, worktree_dir: str) -> None:
    try:
        await _run_git(["worktree", "remove", "--force", worktree_dir], repo_path)
    except RuntimeError:
        shutil.rmtree(worktree_dir, ignore_errors=True)
    try:
        await _run_git(["worktree", "prune"], repo_path)
    except RuntimeError:
        pass


# "Curated context" mode: a cheaper alternative to giving Claude interactive Read/Grep/Glob
# tools (which costs a multi-turn agentic loop — see CODEBASE_CONTEXT_ADDENDUM in claude.py).
# Instead, *we* do one targeted git-grep pass per changed file (grep for its own filename
# stem, e.g. "ChangeInsuredName" from ChangeInsuredName.tsx) to find files that likely
# reference it, and paste bounded snippets of those directly into the one-shot prompt. No
# extra Claude turns, so no compounding re-sent context — just a bigger single prompt.
CURATED_CONTEXT_CHAR_CAP = 20_000
CURATED_CONTEXT_FILES_CAP = 6
CURATED_CONTEXT_PER_FILE_CHAR_CAP = 3_000

_NOISY_REF_PATH_RE = re.compile(r"(^|/)(node_modules|vendor|dist|build|\.git)/")


async def gather_curated_context(
    repo_path: str,
    owner: str,
    repo_name: str,
    number: int | str,
    head_sha: str,
    changed_paths: list[str],
) -> str | None:
    worktree_dir = await prepare_review_worktree(repo_path, owner, repo_name, number, head_sha)
    try:
        blocks: list[str] = []
        seen_paths: set[str] = set(changed_paths)
        budget = CURATED_CONTEXT_CHAR_CAP

        for changed_path in changed_paths:
            if len(blocks) >= CURATED_CONTEXT_FILES_CAP or budget <= 0:
                break
            stem = Path(changed_path).stem
            if len(stem) < 3:  # too generic (e.g. "db", "i18n") to search usefully
                continue
            try:
                out = await _run_git(["grep", "-l", "-F", "--", stem], worktree_dir)
            except RuntimeError:
                continue  # `git grep` exits non-zero when nothing matches — not a real error

            for rel in out.strip().split("\n"):
                rel = rel.strip()
                if not rel or rel in seen_paths or _NOISY_REF_PATH_RE.search(rel):
                    continue
                seen_paths.add(rel)
                try:
                    content = (Path(worktree_dir) / rel).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                snippet = content[:CURATED_CONTEXT_PER_FILE_CHAR_CAP]
                block = f"### {rel} (references {changed_path})\n```\n{snippet}\n```"
                blocks.append(block)
                budget -= len(block)
                if len(blocks) >= CURATED_CONTEXT_FILES_CAP or budget <= 0:
                    break

        return "\n\n".join(blocks) if blocks else None
    finally:
        await cleanup_review_worktree(repo_path, worktree_dir)
