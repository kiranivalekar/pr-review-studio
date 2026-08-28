import copy
import json
import os
from pathlib import Path
from typing import Any

# Two levels up from app/ lands at the project root, same as the Node version's
# two-levels-up from src/ (via import.meta.url) — independent of process cwd.
DB_PATH = Path(__file__).resolve().parents[2] / "data" / "db.json"

EMPTY_DB: dict[str, Any] = {"prs": {}, "reviews": {}}


def _ensure_data_dir() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def read_db() -> dict[str, Any]:
    _ensure_data_dir()
    if not DB_PATH.exists():
        return copy.deepcopy(EMPTY_DB)
    raw = DB_PATH.read_text(encoding="utf-8")
    if not raw.strip():
        return copy.deepcopy(EMPTY_DB)
    parsed = json.loads(raw)
    return {"prs": parsed.get("prs") or {}, "reviews": parsed.get("reviews") or {}}


def write_db(db: dict[str, Any]) -> None:
    _ensure_data_dir()
    tmp_path = DB_PATH.with_suffix(DB_PATH.suffix + ".tmp")
    tmp_path.write_text(json.dumps(db, indent=2), encoding="utf-8")
    os.replace(tmp_path, DB_PATH)


def pr_key(repo: str, number: int) -> str:
    return f"{repo}#{number}"


def upsert_pr(pr: dict[str, Any]) -> dict[str, Any]:
    db = read_db()
    key = pr_key(pr["repo"], pr["number"])
    existing = db["prs"].get(key, {})
    db["prs"][key] = {**existing, **pr}
    write_db(db)
    return db["prs"][key]


def delete_pr(repo: str, number: int) -> None:
    db = read_db()
    key = pr_key(repo, number)
    db["prs"].pop(key, None)
    write_db(db)


def add_linked_pr(repo: str, number: int, linked_repo: str, linked_number: int) -> dict[str, Any] | None:
    db = read_db()
    key = pr_key(repo, number)
    pr = db["prs"].get(key)
    if not pr:
        return None
    linked_key = pr_key(linked_repo, linked_number)
    linked = list(pr.get("linkedPrs") or [])
    if linked_key not in linked:
        linked.append(linked_key)
    pr["linkedPrs"] = linked
    write_db(db)
    return pr


def remove_linked_pr(repo: str, number: int, linked_repo: str, linked_number: int) -> dict[str, Any] | None:
    db = read_db()
    key = pr_key(repo, number)
    pr = db["prs"].get(key)
    if not pr:
        return None
    linked_key = pr_key(linked_repo, linked_number)
    pr["linkedPrs"] = [k for k in (pr.get("linkedPrs") or []) if k != linked_key]
    write_db(db)
    return pr


def list_prs() -> list[dict[str, Any]]:
    db = read_db()
    return list(db["prs"].values())


def create_review(review: dict[str, Any]) -> dict[str, Any]:
    db = read_db()
    db["reviews"][review["id"]] = review
    write_db(db)
    return review


def list_reviews(
    repo: str | None = None, number: int | None = None, state: str | None = None
) -> list[dict[str, Any]]:
    db = read_db()
    reviews = list(db["reviews"].values())
    if repo:
        reviews = [r for r in reviews if r.get("repo") == repo]
    if number is not None:
        reviews = [r for r in reviews if r.get("number") == number]
    if state:
        reviews = [r for r in reviews if any(c.get("state") == state for c in r.get("comments", []))]
    return reviews


def get_review(review_id: str) -> dict[str, Any] | None:
    db = read_db()
    return db["reviews"].get(review_id)


def update_comment(review_id: str, comment_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    db = read_db()
    review = db["reviews"].get(review_id)
    if not review:
        return None
    comment = next((c for c in review.get("comments", []) if c.get("id") == comment_id), None)
    if not comment:
        return None
    comment.update(patch)
    write_db(db)
    return review


def compute_status(repo: str, number: int, db: dict[str, Any]) -> str:
    reviews = [r for r in db["reviews"].values() if r.get("repo") == repo and r.get("number") == number]
    if not reviews:
        return "unreviewed"
    has_pushed = any(c.get("state") == "pushed" for r in reviews for c in r.get("comments", []))
    return "commented" if has_pushed else "reviewed"
