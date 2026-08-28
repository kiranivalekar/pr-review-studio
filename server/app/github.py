import base64
import re
from typing import Any
from urllib.parse import quote

import httpx

from app.config import github_token
from app.errors import AppError

API_BASE = "https://api.github.com"


def _headers(accept: str = "application/vnd.github+json") -> dict[str, str]:
    return {
        "Authorization": f"Bearer {github_token()}",
        "Accept": accept,
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def _gh_fetch(path: str) -> Any:
    async with httpx.AsyncClient() as client:
        res = await client.get(f"{API_BASE}{path}", headers=_headers())
    if res.status_code >= 400:
        raise AppError(
            f"GitHub API {path} failed: {res.status_code} {res.text}",
            404 if res.status_code == 404 else 502,
        )
    return res.json()


async def get_authenticated_login() -> str:
    user = await _gh_fetch("/user")
    return user["login"]


# review-requested (not assignee) is what actually means "this PR needs my review" —
# GitHub's Assignees field is a separate, often-unused concept for who's doing the work.
async def search_review_requested_open_prs(login: str) -> list[dict[str, Any]]:
    q = quote(f"is:pr is:open review-requested:{login}", safe="")
    result = await _gh_fetch(f"/search/issues?q={q}&per_page=50")
    return result["items"]


def parse_pr_url(url: str) -> dict[str, Any]:
    match = re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", str(url).strip())
    if not match:
        raise AppError("Not a GitHub PR URL", 400)
    owner, repo, number = match.groups()
    return {"owner": owner, "repo": repo, "number": int(number)}


async def get_pr(owner: str, repo: str, number: int | str) -> dict[str, Any]:
    return await _gh_fetch(f"/repos/{owner}/{repo}/pulls/{number}")


async def get_pr_diff(owner: str, repo: str, number: int | str) -> str:
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{API_BASE}/repos/{owner}/{repo}/pulls/{number}",
            headers=_headers("application/vnd.github.v3.diff"),
        )
    if res.status_code >= 400:
        raise AppError(
            f"GitHub diff fetch for {owner}/{repo}#{number} failed: {res.status_code} {res.text}",
            404 if res.status_code == 404 else 502,
        )
    return res.text


# Used for hunk-expansion (GitHub-style "show more lines"): the diff only carries
# hunk context, so revealing the lines between/around hunks needs the actual file.
async def get_file_content(owner: str, repo: str, path: str, ref: str) -> str:
    encoded_path = "/".join(quote(seg, safe="") for seg in path.split("/"))
    result = await _gh_fetch(f"/repos/{owner}/{repo}/contents/{encoded_path}?ref={quote(ref, safe='')}")
    if isinstance(result, list) or result.get("type") != "file" or not isinstance(result.get("content"), str):
        raise AppError(f"{path} at {ref} is not a plain file", 422)
    return base64.b64decode(result["content"]).decode("utf-8")


def normalize_pr(pr: dict[str, Any], owner: str, repo: str, source: str) -> dict[str, Any]:
    return {
        "repo": f"{owner}/{repo}",
        "number": pr["number"],
        "title": pr["title"],
        "url": pr["html_url"],
        "author": (pr.get("user") or {}).get("login"),
        "updatedAt": pr["updated_at"],
        "additions": pr.get("additions") or 0,
        "deletions": pr.get("deletions") or 0,
        "source": source,
        "state": "merged" if pr.get("merged_at") else pr["state"],  # "open" | "closed" | "merged"
    }


# Uses the modern line+side form (no manual diff-relative `position` math needed —
# GitHub resolves line+side+commit_id against the diff itself).
async def create_pull_request_review(
    owner: str,
    repo: str,
    number: int | str,
    commit_id: str,
    body: str | None,
    comments: list[dict[str, Any]],
    event: str = "COMMENT",
) -> Any:
    payload: dict[str, Any] = {"commit_id": commit_id, "event": event, "comments": comments}
    if body is not None:
        payload["body"] = body
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{API_BASE}/repos/{owner}/{repo}/pulls/{number}/reviews",
            headers={**_headers(), "Content-Type": "application/json"},
            json=payload,
        )
    if res.status_code >= 400:
        raise AppError(
            f"GitHub review post to {owner}/{repo}#{number} failed: {res.status_code} {res.text}",
            404 if res.status_code == 404 else 502,
        )
    return res.json()


def repo_owner_from_url(repository_url: str) -> dict[str, str | None]:
    # repository_url looks like https://api.github.com/repos/owner/repo
    match = re.search(r"repos/([^/]+)/([^/]+)$", repository_url)
    if not match:
        return {"owner": None, "repo": None}
    return {"owner": match.group(1), "repo": match.group(2)}
