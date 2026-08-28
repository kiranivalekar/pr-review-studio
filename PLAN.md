# PR Review Studio — Full Application Plan

A local application for reviewing PRs with Claude Code: one place to see
what's assigned to you, run a review, edit and push the comments you want,
and track what's been reviewed vs. commented — with room to later automate
the review step.

This supersedes the Phase-1-only plan. Phase 1 (the queue) is built and is
folded in below as the foundation.

## 1. Auth model (unchanged)

- **Claude Code**: `claude login` against your org's Team/Enterprise seat.
  No `ANTHROPIC_API_KEY` anywhere — the backend shells out to the
  already-logged-in `claude` CLI in headless mode (`claude -p ... --output-format json`).
- **GitHub**: `gh` CLI (`gh auth login`) by default, reused for reading PR
  data and posting comments. A `GITHUB_TOKEN` personal access token (`repo`
  scope) is supported as an alternative, calling the GitHub REST API
  directly instead of shelling out to `gh`.
- **Trigger model**: fully manual, by design. You open the app, pick a PR,
  run a review, choose what to push. Auto-review (section 8) is future work
  and opt-in.

## 2. What's new vs. Phase 1

Phase 1 only had a queue that reset on restart. This plan adds:

- A **dashboard** with real counts (assigned / reviewed / commented) and
  recent activity
- A durable **data layer**, since counts and history can't live in memory
  anymore
- The actual **review screen** — run Claude, see suggestions, edit them
- A **reviews history** view across all PRs, not just the current queue
- Real **push-to-GitHub**, tracked per comment
- An architecture that leaves a clean seam for **auto-review** later,
  without needing to rebuild anything

## 3. Data model

Local JSON-file store (`data/db.json`) — no external DB server to install,
plenty for a single-user local tool. (If this grows unwieldy, e.g. hundreds
of PRs with long review histories, the upgrade path is SQLite via
`better-sqlite3`; the API layer below is written so that swap wouldn't
touch the frontend at all.)

```jsonc
// prs — one entry per PR the app knows about
{
  "owner/repo#123": {
    "repo": "owner/repo",
    "number": 123,
    "title": "...",
    "url": "...",
    "author": "...",
    "updatedAt": "...",
    "additions": 42,
    "deletions": 7,
    "source": "assigned" | "manual",
    "status": "unreviewed" | "reviewed" | "commented"
  }
}

// reviews — one entry per review run (a PR can have several over time)
{
  "review_<id>": {
    "id": "review_<id>",
    "repo": "owner/repo",
    "number": 123,
    "createdAt": "...",
    "model": "claude-sonnet-5",
    "comments": [
      {
        "id": "c1",
        "file": "src/auth.ts",
        "line": 88,
        "side": "RIGHT",
        "text": "...",
        "severity": "nit" | "suggestion" | "issue" | "blocking",
        "state": "suggested" | "edited" | "dismissed" | "pushed",
        "pushedAt": null
      }
    ]
  }
}
```

**Status derivation:**
- PR status = `commented` if any review has a `pushed` comment; else
  `reviewed` if it has at least one review run; else `unreviewed`.
- Dashboard counts are just aggregates over `prs` by `status`.

## 4. Architecture

```
┌─────────────────────────────────────────────┐
│  Local web UI                                │
│  Dashboard · Assigned PRs · Review · Reviews │
└───────────────────────┬───────────────────────┘
                        │
                ┌───────▼────────┐
                │ Express backend │
                └───┬────────┬────┘
                    │        │
              ┌─────▼──┐  ┌──▼───────────┐
              │ gh CLI │  │ claude CLI    │
              │(GitHub)│  │ (headless -p) │
              └────────┘  └───────────────┘
                    │
              ┌─────▼──────────┐
              │ data/db.json    │
              │ (prs, reviews)  │
              └─────────────────┘
```

**Navigation:** a left sidebar with four sections — Dashboard, Assigned
PRs, Review (opened per-PR), Reviews (history). Small enough app that a
sidebar keeps switching between them cheap, and each section maps 1:1 to a
plan section below.

## 5. API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/dashboard/stats` | `{ assignedCount, reviewedCount, commentedCount, recentActivity[] }` |
| `GET /api/prs` | Merged assigned + manual PRs, with `status` from the db |
| `POST /api/added-prs { url }` | *(existing)* add a PR by URL |
| `DELETE /api/added-prs/:owner/:repo/:number` | *(existing)* remove a manually-added PR |
| `POST /api/review { repo, number }` | Run Claude on the PR's diff, store a new review record, return it |
| `GET /api/reviews` | All reviews, filterable by `repo`, `number`, or comment `state` |
| `GET /api/reviews/:id` | Single review with its comments |
| `PATCH /api/reviews/:id/comments/:commentId` | Edit text/severity, or dismiss |
| `POST /api/reviews/:id/push` | Push all non-dismissed, non-pushed comments to GitHub; mark `pushed`; update PR `status` |

## 6. Screens

### Dashboard (`/`)
- Three stat cards: **Assigned**, **Reviewed**, **Commented** (counts from
  section 3's derivation — real state, not a decorative KPI row)
- Recent activity: last N review runs and pushes, newest first
- Shortcuts into Assigned PRs and Reviews

### Assigned PRs (`/queue`) — Phase 1, extended
- The existing queue (diffstat gutter, add-by-URL, assigned vs. manual
  badges) stays as-is
- Each row now also shows its **status badge** (unreviewed / reviewed /
  commented), sourced from the db instead of just "source"
- The **Review** button becomes live, navigating to `/review/:owner/:repo/:number`

### PR Review (`/review/:owner/:repo/:number`)
- Header: title, link, diffstat
- Body: suggested comments as editable cards — checkbox to include, file:line,
  editable text, severity tag
- If a review already exists for this PR, show it (with a "run again" option
  that starts a fresh review record) rather than always re-running Claude
- Action: **Push selected** → `POST /api/reviews/:id/push`

### Reviews (`/reviews`) — history across all PRs
- List of every review run: PR, date, comment count, how many pushed
- Click in to re-open the same card view as the Review screen — comments
  already `pushed` show read-only with a "pushed" badge; the rest stay
  editable and can be pushed later

## 7. Build order

| Phase | Scope | Status |
|---|---|---|
| 1 | Queue: assigned PRs + add-by-URL, diffstat gutters | **Done** |
| 2 | Data layer: `data/db.json`, PR status tracking, wire `/api/prs` to it | Next |
| 3 | Dashboard: stats + recent activity | |
| 4 | PR Review screen: Claude call, structured JSON parsing, editable cards | |
| 5 | Push to GitHub: v1 single summary comment, v2 true inline comments | |
| 6 | Reviews history screen | |
| 7 | *(future)* Auto-review — see section 8 | |

**Biggest risk, still true from Phase 1 planning:** getting Claude to return
consistently well-formed structured JSON is the part most worth iterating
on in Phase 4 — budget a few prompt/parse iterations rather than expecting
it to work first try.

**Second biggest risk, new in this plan:** true inline GitHub comments
(Phase 5v2) need Claude's line numbers mapped to GitHub's diff-relative
position (or `line`+`side`+commit SHA) — plan to ship v1 (single summary
comment) first and treat it as a fully acceptable fallback while v2 is
built out, not a stopgap to rush past.

## 8. Future: auto-review (not built now)

Deferred by design, but the architecture already supports it because
**running a review is just a function** (`POST /api/review`'s handler),
independent of any button click. Later, this can be invoked by:

- a scheduler (e.g. poll assigned PRs every N minutes, auto-run Claude on
  new ones)
- a GitHub webhook (if the app is ever run somewhere reachable, rather than
  purely local)

Auto-review would **still stop at "suggested"** — comments land in the
Reviews history as unpushed, so nothing is ever posted to GitHub without
you explicitly pushing it, unless that's a rule you deliberately opt into
later (e.g. "auto-push nit-severity comments only"). That's a policy choice
worth deciding deliberately when this phase is actually built, not baking
in now.

## 9. Open questions to confirm before Phase 2 starts

- **Storage**: JSON file acceptable for v1, or would you rather start with
  SQLite? (Affects nothing user-facing, easy to defer.)
- **"Reviewed" definition**: does a PR count as reviewed the moment Claude
  produces suggestions, or only once you've opened/looked at them in the UI?
- **Scale**: roughly how many PRs/day pass through this? (Affects whether
  the JSON file and the N+1 `gh pr view` calls for diffstats stay fine, or
  need batching sooner.)

## 10. PR review process & checklist

This is the methodology Claude follows when reviewing a PR — not just a
style guide, but the actual reasoning order implemented in
`server/app/claude.py`'s `REVIEW_PROMPT` (per-file findings) and
`SUMMARY_PROMPT` (whole-PR verdict). Design-pattern review happens *after*
understanding the existing system, not before — recommending a familiar
pattern just because it's familiar, when the current architecture already
solves the underlying problem, is a false positive.

**1. Understand the PR first** — what problem is it solving, what's the
expected behavior, does the implementation match the description, what
files/components changed, is there a linked ticket/spec, are the changes
within the intended scope.

**2. Check scope and risk** — do the changes match the PR description, any
unrelated/unnecessary modifications, and is a high-risk area touched: auth,
security-sensitive code, payments, DB migrations, data deletion/modification,
concurrency/state, public APIs, external integrations, performance-critical
code.

**3. Understand the existing code before judging the change** — read the
surrounding implementation, check how the changed function/class/API is used
elsewhere, check for validation/error-handling that already exists in
another layer. Don't assume new code is wrong just because it differs from a
familiar pattern.

**4. System design & architecture** — is the approach appropriate not just
for today's requirement but for likely future changes; is responsibility
clearly scoped; is unnecessary coupling being introduced; is the abstraction
at the right level; is there unjustified complexity or over-engineering;
would this design make a likely future change easier or harder.

**5. Check correctness, in this order** (earlier matters more): functional
bugs / incorrect behavior → security vulnerabilities → data loss/corruption
risk → concurrency/state-management problems → performance and regression
issues → missing/incorrect tests → maintainability and code-quality issues.

**6. Validate assumptions before reporting an issue** — is there already
validation elsewhere, is the behavior guaranteed by the framework/library,
could another layer make the concern moot, is this an intentionally handled
edge case. If a finding depends on an assumption that can't be verified from
what's in front of the reviewer, state the uncertainty explicitly (e.g. "If
userId can be null here, this breaks X; if the controller guarantees
non-null, this isn't an issue") rather than asserting it as a certain bug.

**7. Review the diff as a whole, not line-by-line in isolation** — how do
changed files interact, does a change in one component affect another,
have interfaces/contracts/APIs/schemas/dependencies changed, is backward
compatibility preserved. A line can look correct alone and still be wrong
because of how it interacts with another changed file.

**8. Code quality & maintainability** — readability, naming/abstractions,
ease of future modification, duplication, over/under-engineering, whether it
follows established project conventions.

**9. Security & reliability** — authn/authz, input validation, safe data
access, sensitive-data exposure, data-loss/corruption risk, safe failure
handling, whether retries/timeouts/transactions/idempotency are needed,
whether the system could end up in an inconsistent state.

**10. Performance & scalability** — unnecessary DB calls or network
requests, unnecessary memory/CPU, N+1-style problems, scalability under
growing data/traffic.

**11. Testing** — are appropriate unit/integration tests included, are
important edge cases and failure paths covered, does a test actually
distinguish before-change (failing) from after-change (passing) behavior,
is any existing behavior changed without corresponding test coverage.

**12. Severity, consistently** — Blocker (must fix before merge: critical
correctness/security/data/architecture problem), Major (significant
bug/risk/regression/design problem, normally fix before merge), Minor
(worthwhile improvement, doesn't materially affect correctness), Nit
(style/wording/formatting/preference, never blocks). Maps onto this app's
stored severities as: Blocker → `blocking`, Major → `issue`, Minor →
`suggestion`, Nit → `nit`.

**13. Don't over-report** — raise a comment only for a concrete reason;
never because "another implementation is possible." A good comment explains
what is wrong → why it matters → when it happens → how to fix it.

**14. Actionable comments** — specific, evidence-based, context-aware,
actionable, proportional to severity. Not "this code could be better" —
instead name the concrete coupling/risk and what change would remove it.

**15. Final review gate** — before approving: does the implementation solve
the intended problem, is behavior correct, are security/reliability risks
addressed, is the architecture appropriate, is it maintainable/extensible,
are important edge cases covered, are tests sufficient, any performance
concerns, any remaining blockers/majors.

**Review principle:** understand first → validate assumptions → review
architecture → check correctness → check security/reliability → check
performance → check tests → assess maintainability → classify severity →
give actionable feedback. The goal isn't the maximum number of comments —
it's surfacing the problems and risks that actually matter while confirming
the implementation is correct, maintainable, secure, and extensible.

## 11. Frontend PR review addendum

Same core process as section 10 — this only replaces/extends what "check
correctness" (step 5) and "system design & architecture" (step 4) mean for a
frontend/UI file (React/Vue/Angular/JS/TS/CSS/HTML). Implemented as
`FRONTEND_REVIEW_ADDENDUM` in `server/app/claude.py`, appended to
`REVIEW_PROMPT` per file when that file's extension indicates frontend code
(`FRONTEND_PATH_RE`) — backend-only files never see it, so the extra
UI/accessibility/browser instructions don't dilute a PHP/backend review.
Reviewing only component code quality isn't enough: UI behavior, state,
accessibility, performance, API handling, browser behavior, and
maintainability all need their own pass.

**Project convention — new files must be TypeScript.** Checked first, ahead
of the numbered process below: if the diff shows a file being newly created
(not a rename/move of an existing file) and it's a `.js`/`.jsx` source file
rather than `.ts`/`.tsx`, that's flagged as an issue — new frontend source
files are always written in TypeScript. Root-level tooling/config files that
conventionally stay plain JS even in TS projects (`vite.config.js`,
`tailwind.config.js`, `postcss.config.js`, eslint config, etc.) are exempt —
this only targets app/component source.

**1. Understand the PR first** — what user problem is this solving, what
UI/UX behavior is expected, is there a design/Figma/spec/ticket, which
pages/components/routes/flows are affected, is this a feature/bug
fix/refactor/visual change, are there related backend/API changes.

**2. Understand the existing frontend architecture before commenting** — how
are components currently structured, where does state live, how are API
calls/routing/forms/validation handled, how are shared components/utilities
and the design system used, how does the app already handle loading/error/
empty states. Don't suggest a new pattern until the existing one is
understood.

**3. Component & system design** — is there a clear single responsibility
per component; is a component doing too much (e.g. owning API fetching,
form state, business rules, and presentation all at once); is business
logic unnecessarily coupled to UI; is reusable logic extracted instead of
duplicating an existing component/hook/utility; is the abstraction level
right (not over- or under-engineered); would adding a similar new case (e.g.
another payment method) mean modifying this component, or just adding to
it — extending should be additive, not require touching unrelated code.

**4. Check correctness — for a frontend file, use this order** (replacing
section 10 step 5's backend-oriented order; skip whatever plainly doesn't
apply, e.g. SQL/PHP-specific items):
   a. Functional/UI correctness — does the UI match the requirement/design;
      are loading, empty, and error states all handled; what happens on a
      slow network, an API failure, a double-click, or navigating away
      mid-request; are disabled buttons actually protected against duplicate
      submits; are success/failure messages clear; do refresh/back/forward
      work correctly.
   b. State management — is state kept at the right level (local vs.
      global), no duplicated sources of truth or state that could go stale;
      any race conditions, unnecessary effect triggers, or infinite
      render/effect loops; is derived state stored when it could just be
      computed. For React specifically: scrutinize `useEffect` dependency
      arrays, memoization, callbacks, and stale closures.
   c. API/data handling — is the API contract used correctly (request/
      response shape); are loading/error states handled for this call; any
      unnecessary or duplicate fetches; is caching appropriate; what happens
      if the response is missing an expected field or has an unexpected
      shape.
   d. Security — XSS risk, unsafe raw-HTML rendering, untrusted URLs used
      as-is, secrets/tokens exposed to the client or stored in
      localStorage/sessionStorage, insecure redirects, user content
      rendered without escaping/sanitization. Frontend authorization is
      never a security boundary — the backend must enforce it regardless of
      what the UI does; flag any place this code's logic assumes otherwise.
   e. Accessibility (easy to skip, so give it its own pass) — keyboard
      navigation, focus management, semantic HTML, labels on form controls,
      accessible names on icon-only buttons, appropriate ARIA usage, whether
      the feature works without a mouse.
   f. Performance — unnecessary re-renders, expensive work during render,
      missing lazy-loading/code-splitting or virtualization for large lists,
      unnecessary API calls, blocking main-thread work. Don't recommend
      `memo`/`useMemo`/`useCallback` unless there's an actual, established
      rendering cost — not as a reflexive suggestion.
   g. Responsive/cross-browser — mobile/tablet/desktop and different screen
      sizes, long text, different font sizes, localization if applicable.
      Watch for fixed widths, overflow, and layout that only works at one
      viewport size.
   h. Missing/incorrect tests — see step 6 below.
   i. Maintainability — see step 3 above; only after everything else.

**5. Visual changes** — compare against the linked design/spec if there is
one: spacing, typography, colors, and hover/focus/disabled/error states;
flag if an existing screen looks unintentionally affected. If the project
has visual-regression snapshots, note if they'd need updating.

**6. Testing** — beyond section 10's general test check, look specifically
for coverage of loading/empty/error states, user interactions, form
validation, API failure, and permission/role differences where relevant.
Prefer tests that assert user-visible behavior over implementation detail.

**Recommended frontend review priority:** requirements → architecture →
functional correctness → state/API → security → accessibility →
performance → responsive behavior → testing → maintainability → code style.
Still classify by Blocker → Major → Minor → Nit (section 10 step 12) and
still don't over-report (section 10 step 13) — "this component is 200 lines,
split it" isn't the useful comment; "this component now owns API fetching,
form state, business rules, and presentation, so adding another workflow
will require modifying all of these responsibilities" is.
