# PR Review Studio

A local, single-user web app for reviewing GitHub PRs with Claude Code: see
what's assigned to you, run an AI review, edit the suggested comments, push
the ones you want to GitHub, and track review/comment status per PR over
time.

## Architecture

```
Local web UI (Assigned PRs · Review)
        │
  FastAPI backend (server/app, uvicorn)
    │        │
  GitHub    claude CLI (headless -p)
  REST API
    │
  data/db.json (prs, reviews)
```

- **`client/`** — React + Vite frontend. Vite's dev server proxies `/api` to
  the backend.
- **`server/`** — Python FastAPI backend (`app/main.py`), run via `uvicorn`.
- **`data/db.json`** — local JSON store for PRs and review records (no
  external DB in this build).

Single-screen app: Assigned PRs at `/`, plus a per-PR Review screen at
`/review/:owner/:repo/:number`.

## Prerequisites

- Node.js (client + root tooling)
- Python 3 with a virtualenv at `server/.venv` providing `uvicorn`
- The `claude` CLI, already logged in (used in headless mode — never via
  `ANTHROPIC_API_KEY` directly)
- A GitHub personal access token with `repo` scope

## Setup

```
npm install
```

Copy `server/.env.example` to `server/.env` and fill in:

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT (`repo` scope) used for all GitHub API calls |
| `PORT` | Backend port (default `3011`) |
| `LOCAL_REPOS_ROOT` | Optional root folder of local repo clones, one subfolder per repo name — enables codebase-aware review (Read/Grep/Glob) instead of diff-only |
| `CLAUDE_CLI_PATH` | Optional explicit path to the `claude` binary, if it doesn't resolve on PATH in the server process |

Without `GITHUB_TOKEN`, PR endpoints return a 500 with a clear error rather
than failing silently.

## Running

```
npm run dev
```

Runs the backend (`:3011`) and client (`:5173`) concurrently. The client
proxies `/api` to the backend.

- `npm run dev:server` — backend only
- `npm run dev:client` — client only
- `npm run build` — production build of the client (`client/dist`)

No test suite yet. `client` has `oxlint` (`npm run lint -w client`); nothing
is configured for the server.

## What it does

- **Assigned PRs** — pulls PRs where you're requested as a reviewer (plus any
  manually added by URL), grouped by repo, with status (`unreviewed` /
  `reviewed` / `commented`).
- **Review screen** — renders a PR's diff GitHub-style (unified or split
  view, file tree, hunk expansion) with Claude's suggested comments placed
  inline on the lines they target. Comments are editable (text, severity,
  suggested code) and dismissable before pushing.
- **Push to GitHub** — sends selected, non-dismissed comments as a single
  inline GitHub PR review (real "Apply suggestion" buttons where a
  suggestion is included).
- **Linked PRs** — attach related/dependent PRs so a review can check
  cross-PR consistency (e.g. a frontend PR against the backend API PR it
  depends on) without reviewing the linked PR's own code.
- **Codebase-aware review** — when the PR's repo is found under
  `LOCAL_REPOS_ROOT`, the review runs against a disposable git worktree of
  the PR's head ref with read-only tool access, instead of diff-only.

See [CLAUDE.md](CLAUDE.md) for full internals and [PLAN.md](PLAN.md) for the
original build plan.
