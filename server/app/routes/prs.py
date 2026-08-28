import logging
from typing import Any

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel

from app import db
from app import github
from app.concurrency import map_with_concurrency
from app.errors import AppError

logger = logging.getLogger(__name__)

router = APIRouter()


def _with_status(pr: dict[str, Any], full_db: dict[str, Any]) -> dict[str, Any]:
    return {**pr, "status": db.compute_status(pr["repo"], pr["number"], full_db)}


class AddedPRBody(BaseModel):
    url: str | None = None


@router.get("/prs")
async def list_prs() -> list[dict[str, Any]]:
    login = await github.get_authenticated_login()
    search_results = await github.search_review_requested_open_prs(login)

    assigned_keys: set[str] = set()

    async def refresh_assigned(item: dict[str, Any], _i: int) -> None:
        owned = github.repo_owner_from_url(item["repository_url"])
        owner, repo = owned["owner"], owned["repo"]
        if not owner or not repo:
            return
        try:
            full = await github.get_pr(owner, repo, item["number"])
            pr = github.normalize_pr(full, owner, repo, "assigned")
            db.upsert_pr(pr)
            assigned_keys.add(f"{owner}/{repo}#{item['number']}")
        except Exception as err:
            logger.error("Failed to refresh assigned PR %s/%s#%s: %s", owner, repo, item["number"], err)

    await map_with_concurrency(search_results, 8, refresh_assigned)

    # Refresh manually-added PRs not covered by the assigned fetch above.
    db_before = db.read_db()
    manual_entries = [
        (key, pr) for key, pr in db_before["prs"].items() if pr.get("source") == "manual" and key not in assigned_keys
    ]

    async def refresh_manual(entry: tuple[str, dict[str, Any]], _i: int) -> None:
        key, pr = entry
        owner, repo = pr["repo"].split("/")
        try:
            full = await github.get_pr(owner, repo, pr["number"])
            db.upsert_pr(github.normalize_pr(full, owner, repo, "manual"))
        except Exception as err:
            logger.error("Failed to refresh manual PR %s, keeping stale copy: %s", key, err)

    await map_with_concurrency(manual_entries, 8, refresh_manual)

    # Drop assigned PRs that are no longer open+review-requested (closed, merged, or
    # review no longer needed) — otherwise they'd linger in the db forever since only
    # currently-returned search results get upserted, never pruned.
    for key, pr in db_before["prs"].items():
        if pr.get("source") == "assigned" and key not in assigned_keys:
            db.delete_pr(pr["repo"], pr["number"])

    full_db = db.read_db()
    prs = [
        pr
        for pr in full_db["prs"].values()
        if pr.get("source") == "manual" or pr.get("state") is None or pr.get("state") == "open"
    ]
    result = [_with_status(pr, full_db) for pr in prs]
    result.sort(key=lambda pr: pr.get("updatedAt") or "", reverse=True)
    return result


@router.post("/added-prs", status_code=201)
async def add_pr(body: AddedPRBody) -> dict[str, Any]:
    if not body.url:
        raise AppError("url is required", 400)
    parsed = github.parse_pr_url(body.url)
    owner, repo, number = parsed["owner"], parsed["repo"], parsed["number"]
    full = await github.get_pr(owner, repo, number)
    pr = db.upsert_pr(github.normalize_pr(full, owner, repo, "manual"))
    return _with_status(pr, db.read_db())


@router.get("/prs/{owner}/{repo}/{number}/diff")
async def get_pr_diff(owner: str, repo: str, number: int) -> Response:
    diff = await github.get_pr_diff(owner, repo, number)
    return Response(content=diff, media_type="text/plain")


@router.get("/prs/{owner}/{repo}/{number}/file")
async def get_pr_file(owner: str, repo: str, number: int, path: str = Query(default="")) -> Response:
    if not path:
        raise AppError("path query param is required", 400)
    pr = await github.get_pr(owner, repo, number)
    content = await github.get_file_content(owner, repo, path, pr["head"]["sha"])
    return Response(content=content, media_type="text/plain")


@router.delete("/added-prs/{owner}/{repo}/{number}", status_code=204)
async def delete_added_pr(owner: str, repo: str, number: int) -> Response:
    db.delete_pr(f"{owner}/{repo}", number)
    return Response(status_code=204)


class LinkedPRBody(BaseModel):
    url: str | None = None


# Links a related PR (e.g. a frontend PR alongside the backend/library PR it depends
# on) so a review run can pull in the linked PR's diff as extra cross-PR context.
# Reference only here — the actual context-building happens in routes/reviews.py.
@router.post("/prs/{owner}/{repo}/{number}/links", status_code=201)
async def add_linked_pr(owner: str, repo: str, number: int, body: LinkedPRBody) -> dict[str, Any]:
    if not body.url:
        raise AppError("url is required", 400)
    parsed = github.parse_pr_url(body.url)
    l_owner, l_repo, l_number = parsed["owner"], parsed["repo"], parsed["number"]
    if l_owner == owner and l_repo == repo and l_number == number:
        raise AppError("A PR can't be linked to itself", 400)
    await github.get_pr(l_owner, l_repo, l_number)  # validate it actually exists before storing the link
    pr = db.add_linked_pr(f"{owner}/{repo}", number, f"{l_owner}/{l_repo}", l_number)
    if not pr:
        raise AppError("PR not found — load Assigned PRs at least once before linking", 404)
    return _with_status(pr, db.read_db())


@router.delete("/prs/{owner}/{repo}/{number}/links/{l_owner}/{l_repo}/{l_number}", status_code=204)
async def remove_linked_pr(owner: str, repo: str, number: int, l_owner: str, l_repo: str, l_number: int) -> Response:
    db.remove_linked_pr(f"{owner}/{repo}", number, f"{l_owner}/{l_repo}", l_number)
    return Response(status_code=204)
