import json
import os
from pathlib import Path

from dotenv import load_dotenv

from app.errors import AppError

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

PORT = int(os.environ.get("PORT", "3011"))


def github_token() -> str:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise AppError("GITHUB_TOKEN is not set", 500)
    return token


def local_repos_root() -> str | None:
    return os.environ.get("LOCAL_REPOS_ROOT") or None


def claude_cli_path() -> str:
    return os.environ.get("CLAUDE_CLI_PATH") or "claude"


# review_config.json (not .env) holds review-policy knobs — structured rules rather
# than flat secrets/paths, and meant to be tuned without touching code. Loaded once at
# import time; restart dev:server after editing (same as every other config value here,
# since --reload isn't used — see CLAUDE.md's Known risks).
REVIEW_CONFIG_PATH = Path(__file__).resolve().parent.parent / "review_config.json"


def _load_review_config() -> dict:
    try:
        return json.loads(REVIEW_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


_REVIEW_CONFIG = _load_review_config()


# Each review mode ("diff", "curated", "deep" — see reviews.py's VALID_REVIEW_MODES)
# gets its own section, keyed "<mode>Review", e.g. "deepReview". Every mode reviews
# files in chunks of this size, checking cumulative token usage against
# review_max_tokens(mode) before starting each next chunk — see claude.run_review().
# Files after the budget is hit are skipped, not diff-only'd.
def review_chunk_size(mode: str) -> int:
    return int((_REVIEW_CONFIG.get(f"{mode}Review") or {}).get("chunkSize", 5))


# Total tokens (input + output + cache-read + cache-creation, summed across every file
# reviewed so far in this mode) allowed before a review stops reviewing further files.
# Token-based rather than dollar-based since the ask was to bound context/exploration
# size directly, not spend — set to null in review_config.json to disable the cap for
# that mode entirely.
def review_max_tokens(mode: str) -> int | None:
    value = (_REVIEW_CONFIG.get(f"{mode}Review") or {}).get("maxTokens")
    return int(value) if value is not None else None


# How many per-file claude calls run concurrently within a chunk (claude.py's
# REVIEW_CONCURRENCY) — was a hardcoded constant, moved here alongside the other
# review-policy knobs so it's tunable without touching code.
def review_concurrency() -> int:
    return int(_REVIEW_CONFIG.get("reviewConcurrency", 4))


# Fallback used only if review_config.json is missing/unreadable/malformed, so the app
# still runs with a sane checklist instead of failing every review. Keep this in sync
# with review_config.json's own "checklist" — the file is the source of truth in
# normal operation; this only covers "the file couldn't be loaded at all". "group" is
# "common" (applies regardless of stack), "backend", or "frontend" — see checklist_items().
_DEFAULT_CHECKLIST_ITEMS = [
    {"id": "scope", "group": "common", "label": "Scope — matches the PR's intent, no unrelated changes mixed in"},
    {
        "id": "compatibility",
        "group": "common",
        "label": "Compatibility — contracts/APIs/schemas preserved or safely migrated",
    },
    {"id": "tests", "group": "common", "label": "Tests — adequate coverage for the change, including edge cases"},
    {
        "id": "maintainability",
        "group": "common",
        "label": "Maintainability — readable, consistent with project conventions",
    },
    {
        "id": "backend_security",
        "group": "backend",
        "label": "Security — authn/authz, input validation, no sensitive data exposure",
    },
    {"id": "data_integrity", "group": "backend", "label": "Data integrity — no data loss/corruption risk"},
    {
        "id": "concurrency",
        "group": "backend",
        "label": "Concurrency/state — safe under simultaneous or repeated execution",
    },
    {
        "id": "backend_performance",
        "group": "backend",
        "label": "Performance — no N+1s, unbounded queries, or scalability issues",
    },
    {
        "id": "backend_design",
        "group": "backend",
        "label": "Design/architecture — backend pattern and structure fit the change",
    },
    {
        "id": "ui_correctness",
        "group": "frontend",
        "label": "UI correctness — loading/empty/error states handled, matches requirement",
    },
    {
        "id": "state_management",
        "group": "frontend",
        "label": "State management — no stale/duplicated state or race conditions",
    },
    {
        "id": "frontend_security",
        "group": "frontend",
        "label": "Frontend security — no XSS, unsafe raw HTML, or secrets exposed client-side",
    },
    {
        "id": "accessibility",
        "group": "frontend",
        "label": "Accessibility — keyboard navigation, semantic HTML, ARIA where needed",
    },
    {
        "id": "responsive",
        "group": "frontend",
        "label": "Responsive/cross-browser — works across viewport sizes and browsers",
    },
]

_VALID_CHECKLIST_GROUPS = {"common", "backend", "frontend"}


# The PR-checklist categories shown in the client's "PR checklist" tab (grouped into
# "common"/"backend"/"frontend" sections) and assessed by SUMMARY_PROMPT (see
# claude.py) — edit review_config.json's "checklist" array to add, remove, rename, or
# relabel items without touching code. Each entry needs "id" (stable, used as the row
# key and referenced by SUMMARY_SCHEMA's enum), "label" (shown to the user), and
# "group" (which section of the checklist tab it renders under).
def checklist_items() -> list[dict[str, str]]:
    items = _REVIEW_CONFIG.get("checklist")
    valid = (
        [
            item
            for item in items
            if isinstance(item, dict)
            and item.get("id")
            and item.get("label")
            and item.get("group") in _VALID_CHECKLIST_GROUPS
        ]
        if isinstance(items, list)
        else []
    )
    return valid or _DEFAULT_CHECKLIST_ITEMS
