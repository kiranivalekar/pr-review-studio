import logging
import random
import time
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app import claude, db, github
from app.concurrency import map_with_concurrency
from app.errors import AppError
from app.local_repo import cleanup_review_worktree, find_local_repo, gather_curated_context, prepare_review_worktree

logger = logging.getLogger(__name__)

router = APIRouter()


async def _run_review_with_codebase_context(
    owner: str, name: str, number: int, diff: str, linked_context: str | None
) -> dict[str, Any]:
    repo_path = find_local_repo(name)
    if not repo_path:
        result = await claude.run_review(diff, linked_context=linked_context)
        return {**result, "withCodebaseContext": False}

    worktree_dir = None
    try:
        pr = await github.get_pr(owner, name, number)
        worktree_dir = await prepare_review_worktree(repo_path, owner, name, number, pr["head"]["sha"])
        result = await claude.run_review(diff, cwd=worktree_dir, linked_context=linked_context)
        return {**result, "withCodebaseContext": True}
    except Exception as err:
        logger.warning(
            "Codebase-aware review failed for %s/%s#%s, falling back to diff-only: %s", owner, name, number, err
        )
        result = await claude.run_review(diff, linked_context=linked_context)
        return {**result, "withCodebaseContext": False}
    finally:
        if worktree_dir:
            try:
                await cleanup_review_worktree(repo_path, worktree_dir)
            except Exception:
                pass


# Cheaper alternative to "deep" mode above: instead of an interactive Read/Grep/Glob
# tool loop, we gather bounded context ourselves (local_repo.gather_curated_context —
# one git-grep pass per changed file for likely referencing files) and paste it into a
# single one-shot prompt. Same local-clone requirement and same diff-only fallback.
async def _run_review_with_curated_context(
    owner: str, name: str, number: int, diff: str, linked_context: str | None
) -> dict[str, Any]:
    repo_path = find_local_repo(name)
    if not repo_path:
        result = await claude.run_review(diff, linked_context=linked_context)
        return {**result, "withCodebaseContext": False}

    try:
        pr = await github.get_pr(owner, name, number)
        changed_paths = [c["path"] for c in claude.split_diff_by_file(diff) if c["path"]]
        curated_context = await gather_curated_context(
            repo_path, owner, name, number, pr["head"]["sha"], changed_paths
        )
        result = await claude.run_review(diff, linked_context=linked_context, curated_context=curated_context)
        return {**result, "withCodebaseContext": bool(curated_context)}
    except Exception as err:
        logger.warning(
            "Curated-context review failed for %s/%s#%s, falling back to diff-only: %s", owner, name, number, err
        )
        result = await claude.run_review(diff, linked_context=linked_context)
        return {**result, "withCodebaseContext": False}


# Total cap across all linked PRs' diffs combined, to keep the prompt this gets
# appended to (once per file review call, plus the summary call) from blowing up on a
# huge linked PR — truncated rather than dropped, so partial cross-PR context still helps.
LINKED_CONTEXT_CHAR_CAP = 20_000


async def _build_linked_context(pr: dict[str, Any] | None) -> str | None:
    linked_keys = (pr or {}).get("linkedPrs") or []
    if not linked_keys:
        return None

    parts: list[str] = []
    for linked_key in linked_keys:
        try:
            linked_repo, linked_number_str = linked_key.rsplit("#", 1)
            l_owner, l_name = linked_repo.split("/")
            l_number = int(linked_number_str)
            linked_pr = await github.get_pr(l_owner, l_name, l_number)
            linked_diff = await github.get_pr_diff(l_owner, l_name, l_number)
            parts.append(f"--- Linked PR: {linked_repo}#{l_number} — {linked_pr['title']} ---\n{linked_diff}")
        except Exception as err:
            logger.warning("Failed to fetch linked PR %s for review context: %s", linked_key, err)

    if not parts:
        return None
    combined = "\n\n".join(parts)
    if len(combined) > LINKED_CONTEXT_CHAR_CAP:
        combined = combined[:LINKED_CONTEXT_CHAR_CAP] + "\n\n[... linked PR context truncated ...]"
    return combined


SEVERITY_EMOJI = {"blocking": "🚫", "issue": "⚠️", "suggestion": "💡", "nit": "💬"}


# GitHub renders a ```suggestion fenced block as a real "Apply suggestion" button,
# so this is a genuine upgrade over embedding the replacement as a plain code block.
def _format_inline_body(c: dict[str, Any]) -> str:
    suggestion = f"\n\n```suggestion\n{c['suggestion']}\n```" if c.get("suggestion") else ""
    return f"{SEVERITY_EMOJI.get(c['severity'], '')} **{c['severity']}**\n\n{c['text']}{suggestion}"


# Comments Claude couldn't tie to a specific diff line (line is None) can't be
# posted as inline review comments — GitHub requires path+line for those — so they
# go in the review's overall body instead of being silently dropped.
def _format_unplaced(comments: list[dict[str, Any]]) -> str:
    return "\n\n---\n\n".join(
        f"### {SEVERITY_EMOJI.get(c['severity'], '')} {c['severity']} — `{c['file']}`\n{c['text']}" for c in comments
    )


class PushBody(BaseModel):
    commentIds: list[str] | None = None


@router.post("/reviews/{review_id}/push")
async def push_review(review_id: str, body: PushBody) -> dict[str, Any]:
    review = db.get_review(review_id)
    if not review:
        raise AppError("Review not found", 404)

    eligible = [c for c in review["comments"] if c.get("state") != "dismissed" and c.get("state") != "pushed"]
    to_push = (
        [c for c in eligible if c["id"] in body.commentIds] if body.commentIds is not None else eligible
    )
    if not to_push:
        raise AppError("No comments selected to push", 400)

    owner, name = review["repo"].split("/")
    pr = await github.get_pr(owner, name, review["number"])

    inline = [c for c in to_push if c.get("line") is not None]
    unplaced = [c for c in to_push if c.get("line") is None]

    comments = [
        {
            "path": c["file"],
            "line": c["line"],
            "side": "LEFT" if c.get("side") == "LEFT" else "RIGHT",
            "body": _format_inline_body(c),
        }
        for c in inline
    ]
    # No placeholder text when everything landed inline — an empty/omitted body just
    # shows the line comments themselves, with no extra "review" label above them.
    review_body = (
        f"Comments that couldn't be attached to a specific line:\n\n{_format_unplaced(unplaced)}"
        if unplaced
        else None
    )

    await github.create_pull_request_review(owner, name, review["number"], pr["head"]["sha"], review_body, comments)

    pushed_at = _iso_now()
    updated = review
    for c in to_push:
        updated = db.update_comment(review["id"], c["id"], {"state": "pushed", "pushedAt": pushed_at})
    return updated


def _iso_now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


async def _run_and_store_review(repo: str, number: int, mode: str) -> dict[str, Any]:
    owner, name = repo.split("/")
    diff = await github.get_pr_diff(owner, name, number)
    pr_record = db.read_db()["prs"].get(db.pr_key(repo, number))
    linked_context = await _build_linked_context(pr_record)
    if mode == "deep":
        result = await _run_review_with_codebase_context(owner, name, number, diff, linked_context)
    elif mode == "curated":
        result = await _run_review_with_curated_context(owner, name, number, diff, linked_context)
    else:
        base = await claude.run_review(diff, linked_context=linked_context)
        result = {**base, "withCodebaseContext": False}

    review_id = f"review_{_base36(int(time.time() * 1000))}{_random_base36(4)}"
    review = {
        "id": review_id,
        "repo": repo,
        "number": number,
        "createdAt": _iso_now(),
        "model": "claude-sonnet-5",
        "withCodebaseContext": result["withCodebaseContext"],
        "summary": result.get("summary") or "",
        "usage": result.get("usage") or claude.ZERO_USAGE,
        "comments": [
            {"id": f"c{i + 1}", **c, "state": "suggested", "pushedAt": None}
            for i, c in enumerate(result["comments"])
        ],
    }
    db.create_review(review)
    return review


_BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = []
    while n:
        n, rem = divmod(n, 36)
        digits.append(_BASE36_ALPHABET[rem])
    return "".join(reversed(digits))


def _random_base36(length: int) -> str:
    return "".join(random.choice(_BASE36_ALPHABET) for _ in range(length))


VALID_REVIEW_MODES = {"diff", "curated", "deep"}


class ReviewBody(BaseModel):
    repo: str | None = None
    number: int | None = None
    mode: str = "diff"


@router.post("/review", status_code=201)
async def create_review(body: ReviewBody) -> dict[str, Any]:
    if not body.repo or not body.number:
        raise AppError("repo and number are required", 400)
    if body.mode not in VALID_REVIEW_MODES:
        raise AppError(f"mode must be one of {sorted(VALID_REVIEW_MODES)}", 400)
    return await _run_and_store_review(body.repo, body.number, body.mode)


class BatchReviewBody(BaseModel):
    repo: str | None = None
    numbers: list[int] | None = None


# One repo per batch by design (matches the Assigned PRs accordion, grouped by repo) —
# diff-only only, no deep-review option here, to keep a multi-PR action predictable in
# cost/time. Concurrency capped at 3: each review spawns a real `claude` CLI process,
# heavier than the plain GitHub GETs the PR-list refresh bounds at 8.
@router.post("/reviews/batch", status_code=201)
async def batch_review(body: BatchReviewBody) -> dict[str, Any]:
    if not body.repo or not body.numbers:
        raise AppError("repo and a non-empty numbers array are required", 400)

    results: list[dict[str, Any] | None] = [None] * len(body.numbers)

    async def run_one(number: int, i: int) -> None:
        try:
            review = await _run_and_store_review(body.repo, number, "diff")
            results[i] = {"number": number, "status": "ok", "reviewId": review["id"]}
        except Exception as err:
            results[i] = {"number": number, "status": "error", "error": str(err)}

    await map_with_concurrency(body.numbers, 3, run_one)
    return {"results": results}


@router.get("/usage")
def get_usage() -> dict[str, Any]:
    reviews = db.list_reviews()
    total = claude.sum_usage([r.get("usage") or claude.ZERO_USAGE for r in reviews])
    return {**total, "reviewCount": len(reviews)}


@router.get("/reviews")
def list_reviews(
    repo: str | None = Query(default=None),
    number: int | None = Query(default=None),
    state: str | None = Query(default=None),
) -> list[dict[str, Any]]:
    return db.list_reviews(repo=repo, number=number, state=state)


@router.get("/reviews/{review_id}")
def get_review(review_id: str) -> dict[str, Any]:
    review = db.get_review(review_id)
    if not review:
        raise AppError("Review not found", 404)
    return review


class CommentPatchBody(BaseModel):
    text: str | None = None
    severity: str | None = None
    suggestion: str | None = None
    state: str | None = None


@router.patch("/reviews/{review_id}/comments/{comment_id}")
def patch_comment(review_id: str, comment_id: str, body: CommentPatchBody) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    provided = body.model_dump(exclude_unset=True)
    if "text" in provided:
        patch["text"] = provided["text"]
    if "severity" in provided:
        patch["severity"] = provided["severity"]
    if "suggestion" in provided:
        patch["suggestion"] = provided["suggestion"]
    if "state" in provided:
        patch["state"] = provided["state"]
    elif any(k in provided for k in ("text", "severity", "suggestion")):
        patch["state"] = "edited"

    review = db.update_comment(review_id, comment_id, patch)
    if not review:
        raise AppError("Review or comment not found", 404)
    return review
