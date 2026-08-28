import asyncio
import json
import logging
import re
import subprocess
from typing import Any

from app.concurrency import map_with_concurrency
from app.config import checklist_items, claude_cli_path, review_chunk_size, review_concurrency, review_max_tokens

logger = logging.getLogger(__name__)

REVIEW_CONCURRENCY = review_concurrency()

# Files where a per-line review is never useful — skipping them means fewer, faster
# claude calls with no loss in review quality. Path check is deliberately loose (matches
# anywhere in the path) since these show up nested under workspace subfolders too.
TRIVIAL_PATH_RE = re.compile(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock)$")
GENERATED_PATH_RE = re.compile(r"(^|/)(dist|build|vendor|node_modules)/")
MINIFIED_OR_MAP_RE = re.compile(r"\.(min\.js|min\.css|map)$")

# Extension-based heuristic for "this file is frontend/UI code" — good enough to decide
# whether FRONTEND_REVIEW_ADDENDUM applies. .js/.ts are inherently ambiguous (could be a
# Node backend file), but skew frontend often enough on a typical Laravel+SPA repo that
# the addendum's extra UI/accessibility/browser questions are still more useful than not
# having them; REVIEW_PROMPT already tells Claude to skip whatever plainly doesn't apply.
FRONTEND_PATH_RE = re.compile(r"\.(jsx?|tsx?|vue|svelte|css|scss|sass|less|html?)$", re.IGNORECASE)


def _is_trivial_chunk(file_path: str | None, chunk_text: str) -> bool:
    if "\nBinary files " in chunk_text:
        return True
    if not file_path:
        return False
    return bool(
        TRIVIAL_PATH_RE.search(file_path)
        or GENERATED_PATH_RE.search(file_path)
        or MINIFIED_OR_MAP_RE.search(file_path)
    )


# Splits a unified diff into one chunk per file (each starting at its "diff --git "
# line), so files can be reviewed independently and in parallel instead of one big
# sequential pass over the whole diff.
def split_diff_by_file(diff_text: str) -> list[dict[str, Any]]:
    lines = diff_text.split("\n")
    chunks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def push_current() -> None:
        if current is not None:
            chunks.append({"path": current["path"], "text": "\n".join(current["lines"])})

    for line in lines:
        if line.startswith("diff --git "):
            push_current()
            current = {"path": None, "lines": [line]}
            continue
        if current is None:
            continue  # preamble before the first "diff --git ", if any
        current["lines"].append(line)
        if current["path"] is None:
            if line.startswith("+++ "):
                p = line[4:].strip()
                current["path"] = None if p == "/dev/null" else re.sub(r"^b/", "", p)
            elif line.startswith("rename to "):
                current["path"] = line[len("rename to "):].strip()
    push_current()

    # A pure delete has no "+++ b/..." line to read the path from — fall back to "--- a/...".
    for chunk in chunks:
        if chunk["path"] is None:
            old_line = next((l for l in chunk["text"].split("\n") if l.startswith("--- ")), None)
            if old_line is not None:
                p = old_line[4:].strip()
                chunk["path"] = None if p == "/dev/null" else re.sub(r"^a/", "", p)

    return chunks


REVIEW_PROMPT = """You are a Senior Software Engineer, Technical Lead, and Code Reviewer reviewing one file's changes from a larger production pull request. A unified diff for this single file follows on stdin. Assume it's part of a production Laravel/PHP application unless the file's extension or content clearly indicates another stack — apply the equivalent scrutiny either way.

Perform a deep, practical, risk-focused review — not a syntax or style pass. Do not approve just because the happy path works. Follow this process, in order:

1. Understand the existing code before judging the change. Read the surrounding implementation, not just the diff lines. If Read/Grep/Glob are available, check how the changed function/class/API is used elsewhere, and whether validation or error handling already exists in another layer — don't assume the new code is wrong just because it differs from a pattern you expected.
2. Check correctness, in this priority order — earlier problems matter more than later ones:
   a. Functional / business-logic bugs: does this code do what it's actually meant to do — could it produce a valid technical result but a wrong business result? Correctness across null, empty string, '0', 0, false, empty array/collection, missing keys, unexpected types, boundary/very large values, malformed/invalid dates. In PHP specifically, scrutinize truthy/falsy checks like `if ($value)` against '', '0', 0, 0.0, false, null, [] — is the behavior actually intentional? Also check null safety at every place a value can be null (`find()`, `first()`, `value()`, `optional()`, `?->`, `??`), and that errors/exceptions are caught at the right layer, not swallowed (e.g. `catch (\\Throwable) { return []; }` hiding a real failure).
   b. Security vulnerabilities: authn/authz on the operation, IDOR/BOLA (can changing an ID expose another user's data), SQL injection/unsafe raw queries, mass assignment, XSS, secrets/PII in code or logs, unsafe file uploads. Never treat client-side validation as a security boundary.
   c. Data loss or corruption risk: destructive UPDATE/DELETE without a narrow enough WHERE, missing transactions where multiple writes must be atomic, correct handling of zero rows returned (`find()`/`value()` → null, `get()`/`pluck()` → empty collection).
   d. Concurrency / state-management problems: what happens if two requests run this simultaneously, or a job/webhook/payment operation runs twice — are unique constraints, locks, or idempotency keys needed? Race conditions like check-then-create without a unique constraint.
   e. Performance and regression issues: queries inside loops, `get()` then filtering/counting in PHP where `exists()`/`count()`/`value()`/`pluck()` would do it in the database, missing eager loading, unbounded/unpaginated queries, and whether a response-shape/status-code/validation change could break an existing API consumer.
   f. Missing or incorrect tests implied by this diff.
   g. Only after all the above: maintainability, naming, magic numbers/strings worth naming, unnecessary complexity, over-engineering (abstraction with no real problem it solves) and under-engineering (huge unstructured methods, duplicated business logic). If a dependency list is provided below, also check whether this diff hand-rolls something one of those already-installed libraries provides built-in (e.g. a UI library's own required-field/disabled/loading/tooltip handling, a date/collection utility already in a listed package, a framework helper) — flag reinventing it as a "suggestion" naming the exact built-in to use instead, not a stylistic nitpick.
3. Validate every assumption before reporting an issue. Before flagging something as a bug: is there already validation elsewhere? Is the behavior guaranteed by the framework/library/API? Could another layer make the concern irrelevant? Don't suggest removing a null check just because static analysis claims non-null; if static analysis looks wrong, say so and suggest fixing the type info instead. If a finding depends on an assumption you can't verify from what's in front of you, state that uncertainty explicitly in the comment (e.g. "If X can be null here, this breaks Y; if the caller guarantees non-null, this isn't an issue") rather than asserting it as a certain bug.
4. Consider architecture/design only after you understand the existing system — don't recommend a pattern just because it's familiar; recommend it only if the current code's responsibility is unclear, it introduces unnecessary coupling, or it will make a likely future change harder than it needs to be.
5. Don't over-report. Raise a comment only when there's a concrete reason. Do NOT flag: pure style/formatting preferences, renames, or anything the codebase's existing conventions already do consistently elsewhere — automated tools handle those. Do not comment on code you have not actually read on both sides of the change (don't guess). Skip trivial or already-correct code. Never invent a duplicate of a comment you already made elsewhere. If there's nothing worth flagging, return an empty "comments" array — an empty result is a valid, good outcome.

For each finding, add an entry to "comments" — file, line (as shown in the diff hunk), side ("LEFT" for a removed/original line, "RIGHT" for an added or context line). Write "text" as Markdown, rendered directly to the reviewer, in this shape:
- One bold headline naming the specific problem — e.g. "**Rejected dispatch promises never trigger the fallback**", not a vague label like "bug" or "issue here."
- Prose explaining the discrepancy: what the surrounding comment/spec/existing pattern implies vs. what the code actually does. Quote the exact current code relevant to the finding in a fenced code block (with a language tag matching the file, e.g. ```js) when quoting it makes the problem clearer than prose alone — don't quote code that doesn't add anything.
- The concrete failure scenario: what input, timing, or condition actually triggers it.
- If there's an alternative approach worth showing beyond a single-line drop-in fix — e.g. it needs restructuring, not just a line swap, so "suggestion" below doesn't capture it — show it as a second fenced code block introduced by a short line like "I'd do:" or "Consider:".
Keep it tight: a few sentences and at most two short code quotes, not an essay — this is a review comment, not documentation. Set "severity": "blocking" (Blocker) only for things that would break production, corrupt/lose data, or are a security risk; "issue" (Major) for a real bug, concurrency/state problem, or major correctness/performance issue that should be fixed before merge; "suggestion" (Minor) for a worthwhile improvement that isn't a bug; "nit" (Nit) for a minor/maintainability point that shouldn't block the PR. Mention a concrete strength only when genuinely notable (e.g. "good use of a DB transaction here") — never generic praise, and never as its own comment separate from an actual finding.

Separately from any code quoted inside "text", when you have a concrete, exact code fix in mind for that specific line (or lines), also set "suggestion" to the exact replacement text — matching the original indentation, no diff markers (+/-), no explanation, just the code that should replace what's there, ready to drop in as-is. Set "suggestion" to null when the comment is conceptual (a question, a design concern, something needing a bigger rework, a missing test, or a migration/deployment/rollback risk) rather than a specific line-level edit — an illustrative alternative shown inside "text" doesn't need a matching "suggestion"."""

# Fixed checklist shown in the client's "PR checklist" tab (see PLAN.md §10, condensed
# to the categories that are actually independently checkable — steps like "understand
# the PR first" are reasoning process, not a pass/warning verdict). ids are stable
# across reviews so the frontend can render a consistent list; label is shown alongside
# the status Claude assigns each one. Sourced from review_config.json's "checklist" —
# not hardcoded — so items can be added/removed/relabeled without a code change.
CHECKLIST_ITEMS = checklist_items()
CHECKLIST_ITEM_IDS = [item["id"] for item in CHECKLIST_ITEMS]

SUMMARY_PROMPT = f"""A unified diff for a full GitHub pull request follows on stdin. You are the same senior reviewer providing the overall orientation shown to a reviewer before they read the diff (and before per-file inline findings).

Before writing the summary, reason through the PR as a whole — this shapes the verdict, but isn't itself part of the output:
- What problem is this PR solving, and does the diff actually stay within that scope — any unrelated or unnecessary changes mixed in?
- Does it touch a high-risk area: auth/authz, security-sensitive code, payments/financial operations, database migrations, data deletion or modification, concurrency/state, a public API, an external integration, or performance-critical code?
- Read the diff as a whole, not file-by-file in isolation: do changes in one file affect the correctness of another (a changed interface/contract/schema/dependency other files rely on)? Any backward-compatibility break? A line can look correct alone and still be wrong because of how it interacts with another changed file.
- Are the changes covered by tests proportional to their risk — if the PR changes existing behavior with no corresponding test change, that's a gap worth naming.
- Final gate: does the implementation solve the intended problem, are security/reliability risks addressed, is the architecture appropriate, and are there any remaining blocker- or major-level concerns.

Write "summary" as:

1. One verdict line, exactly one of: "APPROVE", "APPROVE WITH MINOR CHANGES", "CHANGES REQUESTED", or "BLOCK" — based on the overall risk (production breakage, data loss, security, incorrect business logic, a broken cross-file contract, or major performance problems push toward CHANGES REQUESTED/BLOCK; only cosmetic/minor concerns still allow APPROVE WITH MINOR CHANGES).
2. Then 2-4 plain-English sentences: what this PR actually changes and why it matters (the net effect across all files, not a line-by-line recap or diff-stat restatement), whether it stayed in scope, plus a one-line note on the single biggest risk area to pay attention to while reviewing (if any) — e.g. a migration, a destructive query, a new external call, a caching change, or a cross-file contract change.

Format as: "Verdict: <VERDICT> — <sentences>".

Also fill "checklist" — one entry per item below, in this exact set of ids (don't add, skip, rename, or reorder any). Each is tagged [common], [backend], or [frontend] — the diff may contain only backend files, only frontend files, or both:
{chr(10).join(f'- "{item["id"]}" [{item["group"]}]: {item["label"]}' for item in CHECKLIST_ITEMS)}
For each id, set "status" to "pass" (reviewed, no real concern), "warning" (reviewed, and a genuine concern exists — at any severity, even a nit worth naming), or "unchecked" (this item doesn't meaningfully apply to this diff). Use "unchecked" both for a [common] item that plainly doesn't apply (e.g. "tests" for a pure config/docs change) and — importantly — for every [backend] item when the diff touches no backend/server files, or every [frontend] item when the diff touches no frontend/UI files; don't guess or force a verdict on a stack this diff doesn't touch. Set "note" to one short, specific sentence grounded in this diff — name the actual file/behavior, never a generic restatement of the label (e.g. not "security looks fine", instead "no new input crosses a trust boundary in this diff"), or state plainly that this stack isn't part of the diff when marking it "unchecked" for that reason. A "warning" here doesn't have to duplicate an inline comment word-for-word, but should reflect the same underlying concern if one was raised for this category."""

CODEBASE_CONTEXT_ADDENDUM = """

The full repository (at the PR's head commit) is checked out at your current working directory — you have Read, Grep, and Glob available to consult it. Use them where they'd change your review: how a changed function/export is called elsewhere, whether a change matches existing conventions in the same file or module, related types/config the diff doesn't show. Stay targeted — look at this file and things it directly references/imports; do not do an open-ended crawl of the repository."""


# Appended when the PR has one or more linked/dependent PRs (e.g. a frontend PR
# reviewed alongside the backend API PR it depends on, or a PR alongside a shared
# library PR it consumes) — see routes/reviews.py for where linked_context is built.
def _linked_pr_addendum(linked_context: str | None) -> str:
    if not linked_context:
        return ""
    return f"""

The following PR(s) are linked to this one as related/dependent changes (e.g. the frontend PR that consumes this backend change, or vice versa) — use them only as context for reviewing THIS PR's diff, to check cross-PR consistency: does this PR's code actually match what the linked PR changes (a function signature, an API response shape, an exported name, a config key, a shared type)? Do not report bugs that exist purely within the linked PR's own code — that isn't what's being reviewed here.

{linked_context}"""


# Appended for "curated context" mode (routes/reviews.py + local_repo.gather_curated_context)
# — bounded snippets of files that reference the diff's changed files, gathered by us via
# git grep instead of letting Claude spend interactive Read/Grep/Glob turns finding them.
def _curated_context_addendum(curated_context: str | None) -> str:
    if not curated_context:
        return ""
    return f"""

The following additional files from this repository (not part of the diff) were selected because they reference files this diff changes — use them only to understand how the changed code is actually used elsewhere (call sites, existing conventions), the same way you would if you'd looked it up yourself. Do not report bugs in this additional code itself — only in the diff.

{curated_context}"""


FRONTEND_REVIEW_ADDENDUM = """

This file is frontend/UI code (React/Vue/Angular/JS/TS/CSS/HTML).

Project convention, check this first: if the diff header shows this file is newly created (a "new file mode" line, or the old side is /dev/null — not a rename/move of an existing file) and it's a JavaScript source file (.js/.jsx, not .ts/.tsx), flag it as an "issue" — new frontend source files must always be written in TypeScript, not plain JavaScript. Exception: typical root-level tooling/config files that conventionally stay plain JS even in TypeScript projects (e.g. vite.config.js, tailwind.config.js, postcss.config.js, eslint config files) are not a violation — use judgment on whether this is app/component source vs. tooling config.

Keep the process above, but for this file replace step 2's correctness order and fold its content into this order instead — skip whatever plainly doesn't apply (SQL, PHP truthiness, DB transactions, etc.):
a. Functional/UI correctness — does the UI behave per the requirement/design? Are loading, empty, and error states all handled? What happens on a slow network, an API failure, a double-click, or the user navigating away mid-request? Are disabled buttons actually protected against duplicate submits? Are success/failure messages clear? Do refresh/back/forward work correctly?
b. State management — is state kept at the right level (local vs. global), with no unnecessary global state or duplicated sources of truth that could go stale? Could this cause a race condition, an unnecessary effect trigger, or an infinite render/effect loop? Is derived state being stored when it could just be computed? For React specifically: scrutinize `useEffect` dependency arrays, memoization, callbacks, and stale closures.
c. API/data handling — is the API contract used correctly (request/response shape)? Are loading/error states handled for this call? Any unnecessary or duplicate fetches? Is caching appropriate? What happens if the response is missing an expected field or has an unexpected shape?
d. Security — XSS risk, unsafe raw-HTML rendering, untrusted URLs used as-is, secrets/tokens exposed to the client or stored in localStorage/sessionStorage, insecure redirects, user content rendered without escaping/sanitization. Frontend authorization is never a security boundary — the backend must enforce it regardless of what the UI does; flag any place this code's logic assumes otherwise.
e. Accessibility (easy to skip, so give it its own pass) — keyboard navigation, focus management, semantic HTML, labels on form controls, accessible names on icon-only buttons, appropriate ARIA usage, whether the feature works without a mouse.
f. Performance — unnecessary re-renders, expensive work during render, missing lazy-loading/code-splitting or virtualization for large lists, unnecessary API calls, blocking main-thread work. Don't recommend `memo`/`useMemo`/`useCallback` unless there's an actual, established rendering cost — not as a reflexive suggestion.
g. Responsive/cross-browser — mobile/tablet/desktop and different screen sizes, long text, different font sizes, localization if applicable. Watch for fixed widths, overflow, and layout that only works at one viewport size.
h. Missing/incorrect tests, specifically: loading/empty/error states, user interactions, form validation, API failure, and permission/role differences where relevant. Prefer flagging tests that check user-visible behavior over implementation detail.
i. Maintainability — only after everything above.

Also extend step 4 (architecture): is the component's responsibility clear and not doing too much (e.g. owning API fetching, form state, business rules, and presentation all at once)? Is business logic unnecessarily coupled to the UI? Are we duplicating an existing component/hook/utility instead of reusing it — or duplicating a capability the UI library itself already provides (check the dependency list below for the exact library/version in use before assuming custom code was necessary)? Would adding a similar new case (e.g. another payment method, another form field type) mean modifying this component, or just adding to it?

If this is a visual change, compare it against the linked design/spec if there is one — spacing, typography, colors, and hover/focus/disabled/error states — and flag if an existing screen looks unintentionally affected. If the project has visual-regression snapshots, note if they'd need updating."""


BACKEND_NEW_FILE_ADDENDUM = """

This file is backend/server-side code. Project convention, check this first: if the diff header shows this file is newly created (a "new file mode" line, or the old side is /dev/null — not a rename/move of an existing file, and not a config/migration/DTO/plain-data file with no real behavior), add one additional comment on low-level design (LLD) pattern fit — GoF-style object design patterns (Repository, Factory/Abstract Factory, Builder, Strategy, Observer, Decorator, Adapter, Command, Template Method, Facade, Singleton, etc.), not high-level system architecture:
- Name the pattern(s) actually used in this file as written — or say plainly if it's unstructured/procedural code with no discernible pattern.
- Judge whether that's the right fit for what this specific file does and how it's likely to be extended — base this on the file's actual responsibilities, not a reflexive "use pattern X" recommendation.
- If a different or additional pattern would serve this file's real responsibility better, name it specifically and explain concretely why (e.g. "this class both queries the database and enforces business rules — extracting a Repository would let the persistence detail be swapped or mocked in tests without touching the rule logic," not "consider separation of concerns"). If the pattern already in use is the right fit, say so explicitly — a confirming architecture note is still useful context for the reviewer, not a wasted comment.
Set "severity" to "suggestion" for this comment unless the current shape already causes a concrete problem evident from this diff (untestable coupling, a change that will clearly be painful to extend) — only then use "issue". Skip this addition entirely for a file that already existed before this PR."""


COMMENTS_SCHEMA = {
    "type": "object",
    "properties": {
        "comments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "line": {"type": "number"},
                    "side": {"type": "string", "enum": ["LEFT", "RIGHT"]},
                    "text": {"type": "string"},
                    "severity": {"type": "string", "enum": ["nit", "suggestion", "issue", "blocking"]},
                    "suggestion": {"type": ["string", "null"]},
                },
                "required": ["file", "line", "side", "text", "severity", "suggestion"],
            },
        },
    },
    "required": ["comments"],
}

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "checklist": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "enum": CHECKLIST_ITEM_IDS},
                    "status": {"type": "string", "enum": ["pass", "warning", "unchecked"]},
                    "note": {"type": "string"},
                },
                "required": ["id", "status", "note"],
            },
        },
    },
    "required": ["summary", "checklist"],
}


# Runs one headless `claude -p` call over `stdin_text`, validated against `schema`.
# Shared by both the per-file comment calls and the whole-diff summary call.
async def _run_claude_call(
    prompt: str,
    stdin_text: str,
    schema: dict[str, Any],
    cwd: str | None = None,
    tools: str | None = None,
) -> dict[str, Any]:
    # shell=False (the default, not passed explicitly) + relying on PATH resolution
    # of claude.exe directly (a real native binary, not a .cmd shim) is deliberate:
    # routing this through cmd.exe re-quotes the --json-schema argument and silently
    # corrupts it on Windows — same fix as the original Node version.
    args = ["-p", "--output-format", "json", "--json-schema", json.dumps(schema)]
    if tools:
        # Enabling any tools requires bypassPermissions here — verified empirically that
        # a piped -p session with tools enabled but no permission-mode hangs forever with
        # no output, presumably waiting on a prompt that can never arrive over stdin. Safe
        # because the tool set is still restricted to read-only Read/Grep/Glob.
        args += ["--tools", tools, "--permission-mode", "bypassPermissions"]
    else:
        args += ["--tools", ""]

    stdin_payload = f"{prompt}\n\n--- BEGIN DIFF ---\n{stdin_text}\n--- END DIFF ---"

    # asyncio.create_subprocess_exec (not used here) requires a ProactorEventLoop on
    # Windows, but uvicorn --reload forces SelectorEventLoop there (it needs
    # use_subprocess-compatible loop handling for its file-watcher), which has no
    # subprocess support at all and raises NotImplementedError. Running the blocking
    # subprocess.run in a thread sidesteps the event loop's subprocess machinery
    # entirely, so this works under either loop type.
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            [claude_cli_path(), *args],
            cwd=cwd,
            input=stdin_payload.encode("utf-8"),
            capture_output=True,
        )
    except OSError as err:
        raise RuntimeError(
            f"Failed to launch claude CLI ({claude_cli_path()}): {err}. "
            "If `claude` isn't resolvable on PATH in this process's environment, "
            "set CLAUDE_CLI_PATH in server/.env to its full executable path."
        ) from err

    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        stdout = result.stdout.decode("utf-8", errors="replace").strip()
        # A nonzero exit with an empty stderr usually still has the real reason on
        # stdout (the CLI's own JSON error envelope, or a plain-text message when it
        # crashed before it could even produce JSON) — surface whichever isn't empty
        # instead of the previous "no stderr output" dead end.
        detail = stderr or stdout or "no output on stdout or stderr"
        raise RuntimeError(f"claude CLI exited with code {result.returncode}: {detail[:2000]}")

    return _parse_envelope(result.stdout.decode("utf-8", errors="replace"))


async def _run_file_review(
    chunk: dict[str, Any],
    cwd: str | None,
    dep_context: str | None,
    phpstan_context: str | None,
    linked_context: str | None,
    curated_context: str | None,
) -> tuple[list[dict[str, Any]], dict[str, float | int]]:
    is_frontend = bool(FRONTEND_PATH_RE.search(chunk["path"] or ""))
    frontend_addendum = FRONTEND_REVIEW_ADDENDUM if is_frontend else ""
    # LLD/design-pattern check only makes sense for backend files that actually have
    # behavior to structure — frontend gets its own architecture guidance above instead.
    backend_addendum = BACKEND_NEW_FILE_ADDENDUM if not is_frontend else ""
    # dep_context/phpstan_context come from the PR's actual head commit via the GitHub
    # Contents API (see routes/reviews.py) — available in every mode, not just deep —
    # so a Read/Grep/Glob-less diff/curated review still knows what's already installed
    # before suggesting new code that reinvents it (e.g. a UI library's built-in
    # required-field indicator). CODEBASE_CONTEXT_ADDENDUM (the tool-use instructions)
    # stays cwd-gated since only deep mode actually has Read/Grep/Glob available.
    tools_addendum = CODEBASE_CONTEXT_ADDENDUM if cwd else ""
    manifest_addendum = f"{dep_context or ''}{phpstan_context or ''}"
    prompt = (
        f"{REVIEW_PROMPT}{frontend_addendum}{backend_addendum}{tools_addendum}{manifest_addendum}"
        f"{_linked_pr_addendum(linked_context)}{_curated_context_addendum(curated_context)}"
    )
    parsed, usage = await _run_claude_call(
        prompt, chunk["text"], COMMENTS_SCHEMA, cwd=cwd, tools="Read,Grep,Glob" if cwd else None
    )
    return parsed["comments"], usage


async def _run_summary(
    diff_text: str, linked_context: str | None, curated_context: str | None
) -> tuple[str, list[dict[str, str]], dict[str, float | int]]:
    prompt = f"{SUMMARY_PROMPT}{_linked_pr_addendum(linked_context)}{_curated_context_addendum(curated_context)}"
    parsed, usage = await _run_claude_call(prompt, diff_text, SUMMARY_SCHEMA)
    return parsed["summary"], parsed.get("checklist") or [], usage


# Reviews a whole PR diff by splitting it per file and reviewing files in parallel
# (bounded concurrency) instead of one long sequential call over the entire diff —
# the dominant cost for multi-file PRs, and especially for deep review where each
# file's Read/Grep/Glob turns used to run one after another. The summary is generated
# by its own lightweight call, run concurrently with the per-file passes.
async def run_review(
    diff: str,
    mode: str = "diff",
    cwd: str | None = None,
    linked_context: str | None = None,
    curated_context: str | None = None,
    dep_context: str | None = None,
    phpstan_context: str | None = None,
) -> dict[str, Any]:
    chunks = [c for c in split_diff_by_file(diff) if not _is_trivial_chunk(c["path"], c["text"])]

    summary_task = asyncio.ensure_future(_run_summary(diff, linked_context, curated_context))

    per_file_comments: list[list[dict[str, Any]] | None] = [None] * len(chunks)
    per_file_usage: list[dict[str, float | int] | None] = [None] * len(chunks)
    indexed_chunks = list(enumerate(chunks))

    async def review_one(item: tuple[int, dict[str, Any]], _local_i: int) -> None:
        i, chunk = item
        comments, usage = await _run_file_review(
            chunk, cwd, dep_context, phpstan_context, linked_context, curated_context
        )
        per_file_comments[i] = comments
        per_file_usage[i] = usage

    # Every mode ("diff", "curated", "deep" — see review_config.json's "<mode>Review"
    # sections) reviews files in chunks (chunkSize, default 5) instead of all at once
    # when a token budget is configured, checking cumulative tokens spent (input +
    # output + both cache variants — see _total_tokens) before starting each next
    # chunk. Files after the budget is hit are skipped entirely (not diff-only'd) —
    # this bounds a runaway multi-file PR's cost without capping any single file.
    max_tokens = review_max_tokens(mode)
    if max_tokens is not None:
        chunk_size = review_chunk_size(mode)
        spent_tokens = 0
        for start in range(0, len(indexed_chunks), chunk_size):
            if spent_tokens >= max_tokens:
                logger.warning(
                    "%s review token budget (%d) reached after %d/%d files reviewed — skipping remaining %d file(s)",
                    mode,
                    max_tokens,
                    start,
                    len(indexed_chunks),
                    len(indexed_chunks) - start,
                )
                break
            batch = indexed_chunks[start : start + chunk_size]
            await map_with_concurrency(batch, REVIEW_CONCURRENCY, review_one)
            spent_tokens += sum(_total_tokens(per_file_usage[i] or {}) for i, _ in batch)
    else:
        await map_with_concurrency(indexed_chunks, REVIEW_CONCURRENCY, review_one)

    summary, checklist, summary_usage = await summary_task
    comments = [c for group in per_file_comments for c in (group or [])]
    usage = sum_usage([summary_usage, *(u for u in per_file_usage if u)])
    return {"summary": summary, "checklist": checklist, "comments": comments, "usage": usage}


VALID_SEVERITIES = {"nit", "suggestion", "issue", "blocking"}

ZERO_USAGE: dict[str, float | int] = {
    "costUsd": 0.0,
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0,
}


# The claude CLI's JSON envelope reports exact cost/token counts per call (outside
# "structured_output", which only carries our review content) — cache_read vs.
# cache_creation split matters because Anthropic's server-side prompt caching means
# most of REVIEW_PROMPT's cost is only paid once per TTL window, not once per file.
def _extract_usage(envelope: dict[str, Any]) -> dict[str, float | int]:
    usage = envelope.get("usage") or {}
    return {
        "costUsd": envelope.get("total_cost_usd") or 0.0,
        "inputTokens": usage.get("input_tokens") or 0,
        "outputTokens": usage.get("output_tokens") or 0,
        "cacheReadInputTokens": usage.get("cache_read_input_tokens") or 0,
        "cacheCreationInputTokens": usage.get("cache_creation_input_tokens") or 0,
    }


def sum_usage(entries: list[dict[str, float | int]]) -> dict[str, float | int]:
    total = dict(ZERO_USAGE)
    for entry in entries:
        for key in total:
            total[key] += entry.get(key, 0)
    return total


# All token types combined (input + output + both cache variants) — the single number
# review_max_tokens(mode) is compared against, since a cheap cache-read-heavy call and
# an expensive cache-creation-heavy call should count the same toward "how much context
# got processed" rather than "how much this cost."
def _total_tokens(usage: dict[str, float | int]) -> int:
    return int(
        usage.get("inputTokens", 0)
        + usage.get("outputTokens", 0)
        + usage.get("cacheReadInputTokens", 0)
        + usage.get("cacheCreationInputTokens", 0)
    )


def _parse_envelope(stdout: str) -> tuple[dict[str, Any], dict[str, float | int]]:
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"claude CLI did not return a valid JSON envelope: {stdout[:500]}") from err

    if envelope.get("is_error"):
        raise RuntimeError(f"claude CLI reported an error: {envelope.get('result') or stdout[:500]}")

    usage = _extract_usage(envelope)
    structured = envelope.get("structured_output") or {}
    result: dict[str, Any] = {}

    def _coerce_line(value: Any) -> float | int | None:
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    def _coerce_suggestion(value: Any) -> str | None:
        return value if isinstance(value, str) and value.strip() != "" else None

    def _coerce_checklist_status(value: Any) -> str:
        return value if value in {"pass", "warning", "unchecked"} else "unchecked"

    def _coerce_checklist_note(value: Any) -> str:
        return value.strip() if isinstance(value, str) else ""

    if isinstance(structured.get("comments"), list):
        result["comments"] = [
            {
                "file": c["file"],
                "line": _coerce_line(c.get("line")),
                "side": "LEFT" if c.get("side") == "LEFT" else "RIGHT",
                "text": c["text"],
                "severity": c.get("severity") if c.get("severity") in VALID_SEVERITIES else "suggestion",
                "suggestion": _coerce_suggestion(c.get("suggestion")),
            }
            for c in structured["comments"]
            if isinstance(c, dict) and isinstance(c.get("file"), str) and isinstance(c.get("text"), str)
        ]

    if isinstance(structured.get("summary"), str):
        result["summary"] = structured["summary"].strip()

        # Always emit exactly CHECKLIST_ITEMS' ids, in that fixed order, with the
        # label attached server-side — the frontend renders this list as-is instead of
        # keeping its own copy of the labels in sync. Any id Claude omitted (or an
        # invalid status/note) defaults to "unchecked" rather than dropping the row,
        # so the checklist tab always shows a stable, complete list.
        raw_checklist = structured.get("checklist")
        checklist_by_id = (
            {c.get("id"): c for c in raw_checklist if isinstance(c, dict)} if isinstance(raw_checklist, list) else {}
        )
        result["checklist"] = [
            {
                "id": item["id"],
                "label": item["label"],
                "group": item["group"],
                "status": _coerce_checklist_status((checklist_by_id.get(item["id"]) or {}).get("status")),
                "note": _coerce_checklist_note((checklist_by_id.get(item["id"]) or {}).get("note")),
            }
            for item in CHECKLIST_ITEMS
        ]

    if "comments" not in result and "summary" not in result:
        raise RuntimeError(f'claude CLI response had no structured "comments" or "summary": {stdout[:500]}')

    return result, usage
