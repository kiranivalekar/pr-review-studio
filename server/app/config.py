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
