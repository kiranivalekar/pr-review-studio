# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Phases 1-5v1 done: `client/` (React + Vite) and `server/` (Express) as npm
workspaces. PR list (assigned + manual) and status now persist to
`data/db.json` via `server/src/db.js`, wired through `/api/prs` and
`/api/added-prs`. Dashboard and the Reviews-history screen (and
`GET /api/dashboard/stats`) were removed entirely, by request — this is now a
single-screen app: Assigned PRs at `/`, plus the per-PR Review screen.
`client` UI runs on Tailwind v4 with a small primitives library in
`client/src/components/ui/` (`Card`, `Button`, `Badge`, `Input`) — prefer
reusing these over ad hoc classes when building new screens (`StatTile` was
removed along with Dashboard, its only consumer). `GET /api/prs`'s underlying
GitHub search moved from `assignee:` to `review-requested:` — the two are
very different sets on this org (2 PRs vs. 97), so refreshing each match's
full PR data went from a non-issue to a real bottleneck; `mapWithConcurrency`
in `server/src/routes/prs.js` (bounded at 8) brought a 38s load back to ~7s.
`POST /api/reviews/:id/push` (Phase 5, both v1 and v2) is live —
pushes all non-dismissed, non-pushed comments as a real inline GitHub PR
review via `createPullRequestReview()` in `server/src/github.js`: each
comment becomes a line-attached review comment (GitHub's modern `line`+
`side`+`commit_id` form — no manual diff-relative `position` math needed,
despite what the original Known-risks note below assumed), and a `suggestion`
value renders as GitHub's native ` ```suggestion ` block (a real "Apply
suggestion" button). Comments Claude couldn't tie to a line (`line === null`)
go into the review's overall body instead of being silently dropped. Marks
comments `pushed`; PR status flips to `commented` automatically (derived via
`computeStatus()`, no extra write needed). Verified against a real PR twice —
once as v1's flat issue comment, once as v2's inline review.

The full plan lives in `PLAN.md`. Read it in full before Phase 2+ design decisions;
this file is a working summary so routine tasks don't require re-reading it.

## Commands

Run from the repo root (npm workspaces):

- `npm install` — installs client + server deps
- `npm run dev` — runs server (`:3011`) and client (`:5173`, proxies `/api` to
  the server) concurrently
- `npm run dev:server` / `npm run dev:client` — run just one side
- `npm run build` — production build of the client (`client/dist`)

Server needs `server/.env` (copy from `server/.env.example`) with a
`GITHUB_TOKEN` (PAT, `repo` scope) — see Auth model below. Without it, PR
endpoints return a 500 with a clear error rather than failing silently.

No test suite yet. No lint script wired at the root — `client` has `oxlint`
(`npm run lint -w client`) from the Vite scaffold; nothing configured for
`server`.

**Note on tooling versions:** `client` is pinned to Vite 5 (not the Vite 8/
Rolldown-based scaffold `create-vite` defaults to now) because the current
Node version here (20.16) predates Vite 8's native-binding requirements and
hit a broken optional-dependency install. Don't bump past Vite 5 without
checking `node -v` first.

## What this app is

A local, single-user web app for reviewing GitHub PRs with Claude Code: see what's
assigned to you, run an AI review, edit the suggested comments, push the ones you
want to GitHub, and track review/comment status per PR over time.

## Auth model

- **Claude**: shells out to the already-logged-in `claude` CLI in headless mode
  (`claude -p --output-format json --tools "" --json-schema <schema>`, prompt
  piped via stdin). Never use `ANTHROPIC_API_KEY` directly. Wired up in
  `server/src/claude.js` (Phase 4) — see "Known risks" below for the two
  non-obvious gotchas that made this work reliably.
- **GitHub**: this build uses the `GITHUB_TOKEN` PAT (`repo` scope) path,
  calling the REST API directly from `server/src/github.js` — `gh` CLI isn't
  installed on this machine, so that alternative was chosen instead of PLAN.md's
  `gh`-first default. If `gh` becomes available later and you want to switch,
  that's a deliberate swap, not a silent one.
- **Codebase-aware review**: `LOCAL_REPOS_ROOT` (`server/.env`) points at a
  folder of existing local clones, one subfolder per repo name (e.g.
  `F:\GFS_SaaS\gfs-saas-core`). When the reviewed repo is found there,
  `server/src/localRepo.js` fetches the PR's head ref and checks it out into
  a disposable `git worktree` (never touches the clone's actual checkout/
  branch/uncommitted work), and `runReview()` runs with `cwd` set there and
  `Read`/`Grep`/`Glob` enabled instead of diff-only — see "Known risks"
  below for the CLI flags this requires. Falls back to diff-only whenever
  the repo isn't found under `LOCAL_REPOS_ROOT`, or any git step fails.
- **Trigger model**: fully manual. No polling/scheduling/webhooks in the current
  build — see "Auto-review" below before adding any.

## Architecture

```
Local web UI (Assigned PRs · Review)
        │
  Express backend
    │        │
  gh CLI   claude CLI (headless -p)
    │
  data/db.json (prs, reviews)
```

Left-sidebar nav with one section (Assigned PRs); Review is opened per-PR via
a row action, not a nav link. Dashboard and a Reviews-history screen existed
earlier in the plan but were removed by explicit request — don't re-add
either without being asked again, this was a deliberate scope cut, not an
oversight.

**Folders:** `client/` (React + Vite, Vite dev server proxies `/api` to
`:3011`) and `server/` (Express, ESM). Root `package.json` uses npm workspaces
— run everything from the repo root, not from inside `client`/`server`
directly, except for one-off single-side commands.

**Assigned PRs** (`client/src/pages/AssignedPRs.jsx`) groups the flat PR list
by repo into collapsible accordion sections (`groupByRepo()`, repo groups
ordered by repo name descending, Z-A — by explicit request, not by recency).
Expanded by default (`collapsedRepos` starts empty); local UI state with a
"Collapse all"/"Expand all" toggle, not persisted. Each PR row now shows just
`#N` since the repo is already the group header.

Currently routed screens: `/` (Assigned PRs, fully wired) and
`/review/:owner/:repo/:number` (fully wired, including push to GitHub — see
"Review screen" below). Only the Review screen's page wrapper skips the
shared `max-w-5xl` reading width (`App.jsx` no longer imposes one globally)
— a diff view needs the room.

**Review screen** renders comments inline on the actual diff, GitHub-style,
not as a flat list:
- `client/src/lib/parseDiff.js` — parses the raw unified diff (fetched via
  `GET /api/prs/:owner/:repo/:number/diff`) into `files[].hunks[].lines[]`
  with old/new line numbers; `matchCommentsToDiff` attaches each review
  comment to the line it targets (falls back to an "Other comments" section
  for anything that doesn't match, so a stale review/off-by-one never
  silently disappears); `toSplitRows` regroups a hunk's flat line sequence
  into paired left/right rows for split view (consecutive deletions line up
  against the consecutive additions that follow, GitHub's own heuristic).
- `client/src/components/DiffView.jsx` — renders the file/hunk/line table,
  with a Unified/Split toggle (GitHub-style) at the top; comment threads
  render as a full-width row directly under the line they target.
- `client/src/components/CommentCard.jsx` — the editable comment itself
  (severity, text, dismiss/restore); when a comment has a `suggestion`, it
  also renders a GitHub-style "Suggested change" box (editable, green-tinted
  code block). A selection checkbox (hidden once dismissed/pushed) controls
  whether the comment is included in the next push — this replaced the
  earlier disabled "Add suggestion to batch" stub once push actually shipped.
- `client/src/pages/Review.jsx` tracks that selection as a `selectedIds` Set,
  reset to "everything pushable" whenever a *different* review loads (not on
  every dismiss/restore); `Push N comments` sends exactly those ids to
  `POST /reviews/:id/push`, and a `Select all`/`Deselect all` link is a thin
  wrapper over the same state — no separate persisted "selected" field on
  the comment itself, this is push-time-only client state.
- `client/src/components/FileTree.jsx` + `buildFileTree()`/`fileElementId()`
  in `parseDiff.js` — a collapsible GitHub-style folder tree of changed
  files (toggle button above the diff, sticky in the left column), each
  entry showing a `+N`/`-N` diffstat; clicking a file scrolls the diff panel
  to it via `scrollIntoView` against an `id` set on each file's container in
  `DiffView.jsx`. No scroll-spy — the tree doesn't track which file is
  currently in view while scrolling by hand, only highlights the last file
  explicitly clicked.
- **Per-file collapse** (`DiffView.jsx`, `collapsedFiles` Set state): clicking
  a file's header toggles its `<table>` away entirely, matching GitHub's
  collapse-file affordance. Purely local UI state, not persisted.
- **Hunk expansion** (GitHub's "show more lines" arrows) — the diff itself
  only carries hunk context, so revealing the lines a hunk omits needs the
  actual file: `GET /api/prs/:owner/:repo/:number/file?path=...` (new route
  in `server/src/routes/prs.js`, backed by `getFileContent()` in
  `github.js` via the Contents API at the PR's head SHA) returns the raw
  file text, fetched lazily client-side (`fetchFileContent` in `api.js`) the
  first time any gap in that file is expanded, then cached.
  `computeGaps()` in `parseDiff.js` derives the hidden regions from each
  hunk's `oldStart/newStart/oldEnd/newEnd` (added to hunk parsing): before
  the first hunk (`lead`), between two hunks (`mid`), after the last hunk
  (`trail`, bound unknown until the file's fetched). `DiffView.jsx` tracks
  reveal progress per gap as `{top, bottom}` — lines revealed growing down
  from the hunk above / up from the hunk below — so a `mid` gap's two arrow
  buttons expand independently in 20-line chunks until they meet and the
  separator disappears; `lead`/`trail` gaps only have one open edge, so
  `lead` reveals its entire (usually small) span in one click and `trail`
  reveals in the same 20-line chunks since it can be arbitrarily long.
- **Commented-line highlighting**: any diff line (in either view mode) with
  an attached comment thread gets a left-border/background accent plus a
  small icon, via `matcher.commentsForLine()` — same matcher `parseDiff.js`
  already used to place the thread itself, just also read one level up to
  decide the line's own styling.
- **Linked PRs** (`Link2` section on the Review screen, above the diff):
  lets you attach one or more related/dependent PRs to the one being
  reviewed — e.g. a frontend PR linked to the backend API PR it depends on,
  or a PR linked to a shared library PR it consumes. Stored as
  `linkedPrs: string[]` (each an `owner/repo#number` key) on the PR's
  `data/db.json` record via `POST/DELETE /api/prs/:owner/:repo/:number/links`
  (`server/app/routes/prs.py`, `db.add_linked_pr`/`db.remove_linked_pr`).
  When a review is run, `_build_linked_context()` in
  `server/app/routes/reviews.py` fetches each linked PR's diff (capped at
  20,000 chars combined, truncated not dropped) and passes it into
  `claude.run_review(..., linked_context=...)`, which appends it as an
  addendum to both the summary call and every per-file call
  (`_linked_pr_addendum()` in `server/app/claude.py`) — explicitly scoped to
  "use this only to check cross-PR consistency, don't review the linked
  PR's own code for its own bugs." Verified against a real PR: linking an
  unrelated PR correctly produced "no shared files, no contract overlap"
  in the summary rather than a fabricated connection.

## Data model (`data/db.json`)

Local JSON file — deliberately no external DB for v1. If it ever needs to scale
(hundreds of PRs, long histories), the planned upgrade is SQLite via
`better-sqlite3`, with the API layer as the seam so the frontend doesn't change.

- **`prs`** keyed by `owner/repo#123`: repo metadata (title, url, author, diffstat)
  plus `source` (`assigned` | `manual`), `status` (`unreviewed` | `reviewed` |
  `commented`), and `linkedPrs` (`string[]` of `owner/repo#number` keys — see
  "Linked PRs" above; absent/empty for most PRs).
- **`reviews`** keyed by `review_<id>`: one entry per review *run* (a PR can have
  several over time), each holding a `comments[]` array with
  `severity` (`nit` | `suggestion` | `issue` | `blocking`), `state`
  (`suggested` | `edited` | `dismissed` | `pushed`), and `suggestion` (a
  nullable string — the exact replacement code for that line, rendered as a
  GitHub-style suggestion block; `null` when the comment is conceptual
  rather than a concrete line edit). `file`/`line`/`side` place the comment
  in the diff — see "Review screen" above.

**Status derivation (don't store this redundantly — derive it):**
- PR `status` = `commented` if any review has a `pushed` comment; else `reviewed`
  if it has ≥1 review run; else `unreviewed`. Computed via `computeStatus()`
  in `db.js`, read by `GET /api/prs` — nothing else consumes it now that
  Dashboard is gone.

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/prs` | Merged review-requested + manual PRs, `status` from the db |
| `GET /api/prs/:owner/:repo/:number/diff` | Raw unified diff text (proxies GitHub's diff media type) |
| `GET /api/prs/:owner/:repo/:number/file?path=...` | Raw file content at the PR's head SHA (for hunk expansion) |
| `POST /api/added-prs { url }` | add a PR by URL (existing, Phase 1) |
| `DELETE /api/added-prs/:owner/:repo/:number` | remove a manually-added PR (existing, Phase 1) |
| `POST /api/prs/:owner/:repo/:number/links { url }` | link a related/dependent PR (any repo) by URL |
| `DELETE /api/prs/:owner/:repo/:number/links/:lOwner/:lRepo/:lNumber` | remove a linked PR |
| `POST /api/review { repo, number }` | run Claude on the PR diff (plus linked-PR context if any), store a new review record |
| `GET /api/reviews` | all reviews, filterable by `repo`, `number`, comment `state` |
| `GET /api/reviews/:id` | single review with its comments |
| `PATCH /api/reviews/:id/comments/:commentId` | edit text/severity/suggestion, or dismiss a comment |
| `POST /api/reviews/:id/push` | push all non-dismissed, non-pushed comments to GitHub; mark `pushed`; update PR `status` |

`POST /api/review`'s handler is deliberately just a function, independent of any
button click — this is the seam future auto-review hooks into (see below).

## Build order (current plan sequencing)

1. ✅ Queue: review-requested PRs + add-by-URL, diffstat gutters
2. ✅ Data layer: `data/db.json`, PR status tracking, wired to `/api/prs`
3. ❌ Dashboard — built, then removed entirely by explicit request; not a gap to fill
4. ✅ PR Review screen: Claude call, structured JSON parsing, editable cards
5. ✅ Push to GitHub (v1 flat comment, then upgraded to v2 real inline comments)
6. ❌ Reviews history screen — never built; removed from the plan by explicit
   request (the placeholder nav link was deleted, not just left unbuilt)
7. ⬜ *(future)* Auto-review — **next**, if asked

## Known risks to design around

- **Structured output from Claude (Phase 4) — resolved.** Two things were
  necessary, not just prompt wording: (1) `--tools ""` on the headless call —
  without it, the model sometimes goes exploring the filesystem for the repo
  (it isn't there) instead of just reviewing the diff, wasting turns and time;
  (2) `--json-schema` — this returns a pre-validated `structured_output` field
  in the envelope, which `server/src/claude.js` reads directly instead of
  parsing prose out of `result`. Relying on "respond with ONLY JSON" instructions
  alone was not reliable — the model would sometimes answer in prose when it had
  substantive findings. Separately: the prompt/schema **must** go over stdin, not
  as a CLI argument — `spawn(..., { shell: true })` on Windows lets cmd.exe
  requote a long multi-line argument and silently corrupts it (drops
  `--output-format` entirely, falling back to plain text). Fix was `shell: false`
  and letting `claude.exe` (a real binary, not a `.cmd` shim) resolve via PATH
  directly — no shell involved, so no requoting.
- **Codebase-aware review CLI flags**: enabling tools changes two things
  from the diff-only call. (1) `--permission-mode bypassPermissions` is
  required — verified empirically that `claude -p --tools "Read,Grep,Glob"`
  with no permission-mode hangs forever with zero output once cwd/tools are
  set, presumably waiting on a permission prompt that can never arrive over
  a piped stdin session. Safe here because `--tools` is still restricted to
  read-only tools (no Bash/Edit/Write ever allowed), so bypass only skips
  the per-call prompt, not the tool restriction itself. (2) `--bare` is NOT
  an option to speed this up — it forces `ANTHROPIC_API_KEY`/`apiKeyHelper`
  auth only and breaks the already-logged-in CLI session this app relies on
  (see Auth model above). (3) An unguided task (e.g. plain `Glob` with no
  target) is slow and expensive — one test took 50 turns / 120s / $0.46 just
  to list a repo's top-level directories. The review prompt must point
  Claude at the diff's touched files and their direct references, not invite
  open-ended exploration.
- **Inline GitHub comments (Phase 5v2) — resolved, turned out simpler than
  expected**: the original worry was mapping Claude's line numbers to GitHub's
  diff-relative `position`. Turns out the modern Pull Request Review API
  (`POST /repos/:owner/:repo/pulls/:number/reviews`) accepts `line`+`side`+
  `commit_id` directly and resolves `position` itself — no manual diff-math
  needed, since our comments already store exactly those fields. One real
  risk instead: this call is atomic per review — if any single comment's
  `line`/`path` doesn't resolve against `commit_id`'s diff, the whole push
  request fails (not just that one comment). Not yet hit in practice; if it
  becomes an issue, per-comment retry/skip is the fix, not before.
- **Server port is 3011, not the more obvious 3001.** On this dev machine,
  port 3001 got stuck in a state where `netstat`/`Get-NetTCPConnection`
  report a listener on it (and it answers real HTTP responses) but the
  reported owning PID never matches any actual process — confirmed via
  `Get-CimInstance Win32_Process`, `tasklist`, and even elevated/host-level
  checks. Whatever's actually bound to 3001 predates the current backend
  and serves stale 404s for every route. Rather than keep fighting an
  unkillable ghost listener, the server (and the Vite proxy target) moved
  to 3011 — `package.json`'s `dev:server` script, `client/vite.config.js`,
  `server/.env(.example)`'s `PORT`, and `config.py`'s default all agree on
  3011 now. If this repo ever moves to a machine without that specific
  Windows quirk, moving back to 3001 is safe — nothing else depends on the
  number.
- **`dev:server` deliberately does not pass `--reload`.** On this machine,
  uvicorn's `--reload` (WatchFiles) doesn't just fail to hot-swap after a
  file save (it logs "Reloading…" but the old worker keeps running stale
  code indefinitely) — while its file-watcher thread is active in the
  worker process, `POST /api/review` can fail outright with
  `claude CLI exited with code 3221225794: no output on stdout or stderr`
  (`0xC0000142` / `STATUS_DLL_INIT_FAILED`), because `asyncio.to_thread(subprocess.run, [claude, ...])`
  in `claude.py` can't reliably spawn the (Node-based) `claude` binary as a
  child of that process while WatchFiles' thread is running. Confirmed via
  a side-by-side: the exact same request against a `--reload`-free instance
  on a throwaway port succeeded immediately; against the `--reload`
  instance it failed consistently, in both diff-only and codebase-aware
  modes. Net effect either way: a code change needs a real restart of
  `npm run dev`/`dev:server`, not a file save — so `--reload` bought
  nothing here and cost real review failures. Don't re-add it without
  verifying this machine's behavior has actually changed.

## Auto-review (do not build unprompted)

Deferred by design. If asked to add scheduling/webhooks/polling: auto-review
should still stop at "suggested" — comments land in `data/db.json` unpushed
(there's no Reviews-history screen to surface them in; `GET /api/reviews`
still exists as an API, just nothing in the UI lists it globally).
Never have automation call the push endpoint directly unless the user has
explicitly opted into a specific policy (e.g. "auto-push nit-only") — that's a
deliberate decision to make at Phase 7, not a default.

## Open questions (confirm with the user before Phase 2, if not already answered)

- ~~Storage~~ — confirmed: JSON file (`data/db.json`) for v1.
- "Reviewed" status: set the moment Claude produces suggestions, or only once
  the user opens/views them in the UI?
- ~~Expected scale~~ — answered: `review-requested:` surfaces ~50-100 open
  PRs on this org (`assignee:` had only surfaced ~2 — the two are genuinely
  different GitHub concepts). The N+1-per-PR refresh loop in `GET /api/prs`
  hit a real wall at that volume (38s) and was fixed with bounded-concurrency
  fetching (`mapWithConcurrency`, limit 8) rather than batching/caching — the
  JSON file itself is still fine at this scale, only the GitHub round-trips
  needed to not be sequential.
