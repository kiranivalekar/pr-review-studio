"""
Full replacement for the PR-review module.

Keeps the existing behavior but applies the main performance/cost changes:

- Keeps the cached system prompt byte-identical across PRs: per-PR context
  (dependency manifest, PHPStan config, linked PRs, curated files) rides in
  the user turn instead of being concatenated onto the system prompt. See
  _run_batch_review.
- Caches the deep-mode static review prompt too.
- Uses one shared Claude concurrency limiter, so the deep summary counts
  against the same concurrency budget.
- Makes the token budget accounting more predictable by reserving an
  estimated per-call budget before launching work.
- Keeps cache priming for diff/curated mode, but avoids making the whole
  review wait on unrelated variant primers.
- Pre-serializes JSON schemas.
- Keeps the existing full-diff summary semantics, rather than changing
  review quality by summarizing only the per-file results.
- Avoids duplicating curated context in deep mode when the repository
  itself is available.
- Preserves the existing JSON parsing and output contracts.

One important caveat: a token budget cannot be a mathematically hard upper
bound unless the CLI/API itself accepts a per-call max_tokens limit. The
code below therefore treats the configured review budget as a scheduling
budget, not a guaranteed billing ceiling.

MEASURED COST CEILING — prompt caching does not work through the CLI.

Verified empirically on this machine (claude-sonnet-5, `claude -p`):

  - A call piping the single word "hi", with no review prompt at all, bills
    ~14,700 cache-creation + ~3,289 cache-read tokens. That is the floor for
    invoking the CLI at all.
  - With --system-prompt-file, the floor drops to ~8,752 tokens of Claude
    Code harness (agent scaffolding this workload never uses) on top of our
    own ~3,554-token review prompt: ~71% of the cached prefix is overhead.
  - Enabling --tools "Read,Grep,Glob" (deep mode) adds ~3,157 more tokens of
    tool definitions per call.
  - Critically: the CLI exposes only ONE reusable cache breakpoint, ~1,442
    tokens into its own preamble. Our system prompt is cached in the SAME
    block as the piped user turn, so a differing diff invalidates it. Three
    calls sharing one identical system-prompt file but different diffs each
    reported cacheCreate=8744 / cacheRead=1442.

Net effect: every review call re-writes ~8.7k+ tokens to cache and never
reads them back. Because cache creation bills at a premium over ordinary
input (1.25x at the 5-minute TTL, 2x at the 1-hour TTL), the caching path
costs MORE than sending the same tokens uncached — it is a penalty, not a
saving, and no amount of prompt restructuring fixes it from inside the CLI.

The actual fix is a transport change: call the Messages API directly with an
explicit cache_control breakpoint placed after the system prompt and before
the diff. That removes the ~8.7k/call harness entirely and makes the review
prompt a genuine reusable prefix (read at 0.1x) while the varying diff bills
as plain input. It conflicts with this project's "never use
ANTHROPIC_API_KEY, shell out to the logged-in CLI" auth model (see
CLAUDE.md), so it is a deliberate decision, not something to change quietly.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from app.concurrency import map_with_concurrency
from app.config import (
    backend_repo_names,
    batch_max_diff_tokens,
    batch_max_files,
    checklist_items,
    claude_cli_path,
    estimate_chars_per_token,
    estimate_reserve_tokens,
    frontend_repo_names,
    review_concurrency,
    review_max_tokens,
    review_model,
)

logger = logging.getLogger(__name__)

REVIEW_CONCURRENCY = review_concurrency()
REVIEW_MODEL = review_model()

# Files where a per-line review is never useful.
TRIVIAL_PATH_RE = re.compile(
    r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock)$"
)
GENERATED_PATH_RE = re.compile(r"(^|/)(dist|build|vendor|node_modules)/")
MINIFIED_OR_MAP_RE = re.compile(r"\.(min\.js|min\.css|map)$")

# Frontend classification.
FRONTEND_UNAMBIGUOUS_RE = re.compile(
    r"\.(jsx|tsx|vue|svelte|css|scss|sass|less|html?)$",
    re.IGNORECASE,
)
AMBIGUOUS_SCRIPT_RE = re.compile(r"\.(js|ts)$", re.IGNORECASE)
REPO_FRONTEND_NAME_RE = re.compile(r"front", re.IGNORECASE)

FRONTEND_REPO_NAMES = frontend_repo_names()
BACKEND_REPO_NAMES = backend_repo_names()


def _classify_frontend(path: str | None, repo_name: str) -> bool:
    if not path:
        return False

    if FRONTEND_UNAMBIGUOUS_RE.search(path):
        return True

    if AMBIGUOUS_SCRIPT_RE.search(path):
        name = repo_name.lower()

        if name in FRONTEND_REPO_NAMES:
            return True

        if name in BACKEND_REPO_NAMES:
            return False

        return bool(REPO_FRONTEND_NAME_RE.search(repo_name))

    return False


ASSET_OR_DATA_PATH_RE = re.compile(
    r"\.(json|svg|png|jpe?g|gif|ico|webp|bmp|avif|woff2?|ttf|eot|otf|lock|md|mdx|csv|ya?ml)$",
    re.IGNORECASE,
)


def _is_asset_or_data_file(path: str | None) -> bool:
    return bool(path) and bool(ASSET_OR_DATA_PATH_RE.search(path))


def _addendum_variant(path: str | None, repo_name: str) -> str:
    if _is_asset_or_data_file(path):
        return "asset"

    return "frontend" if _classify_frontend(path, repo_name) else "backend"


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


def split_diff_by_file(diff_text: str) -> list[dict[str, Any]]:
    lines = diff_text.split("\n")
    chunks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def push_current() -> None:
        if current is not None:
            chunks.append(
                {
                    "path": current["path"],
                    "text": "\n".join(current["lines"]),
                }
            )

    for line in lines:
        if line.startswith("diff --git "):
            push_current()
            current = {
                "path": None,
                "lines": [line],
            }
            continue

        if current is None:
            continue

        current["lines"].append(line)

        if current["path"] is None:
            if line.startswith("+++ "):
                path = line[4:].strip()
                current["path"] = (
                    None if path == "/dev/null" else re.sub(r"^b/", "", path)
                )

            elif line.startswith("rename to "):
                current["path"] = line[len("rename to "):].strip()

    push_current()

    # Pure deletes have no +++ b/... line.
    for chunk in chunks:
        if chunk["path"] is not None:
            continue

        old_line = next(
            (line for line in chunk["text"].split("\n") if line.startswith("--- ")),
            None,
        )

        if old_line is not None:
            path = old_line[4:].strip()
            chunk["path"] = None if path == "/dev/null" else re.sub(r"^a/", "", path)

    return chunks


# ---------------------------------------------------------------------------
# Review prompts
# ---------------------------------------------------------------------------

REVIEW_PROMPT_FULL = """You are a Senior Software Engineer, Technical Lead, and production Code Reviewer.

You are reviewing changes to one or more files from a larger production pull request. Each file's unified diff is provided on stdin (see the delimiter format below when more than one file is included).

Assume the project is a production Laravel/PHP application unless the file extension or content clearly indicates another stack. Apply equivalent scrutiny for other stacks.

Your job is to identify REAL, ACTIONABLE problems introduced or materially affected by this change. This is a risk-focused code review, NOT a syntax, formatting, or style review.

Follow the review process below in order.

1. UNDERSTAND THE EXISTING CODE

Before judging the diff, understand the surrounding implementation.

If repository tools such as Read, Grep, or Glob are available:
- Read the changed function, class, method, component, or API in context.
- Inspect important callers and consumers.
- Check existing validation, authorization, error handling, transactions, and related implementations.
- Check framework/library behavior when relevant.
- Check existing project conventions before calling something a problem.

Do NOT assume the changed code is wrong simply because it differs from a pattern you expected.
Do NOT report an issue based on code you have not actually inspected when that context is available.
If required context is unavailable, explicitly state the uncertainty instead of presenting an assumption as a definite bug.

2. REVIEW CORRECTNESS - IN THIS PRIORITY ORDER

A. FUNCTIONAL / BUSINESS-LOGIC BUGS

First determine whether the code actually does what the business behavior requires.

Look for:
- incorrect conditions or state transitions
- wrong defaults
- incorrect calculations
- incorrect filtering or selection
- valid technical results that represent the wrong business result
- incorrect API responses or status codes
- incorrect handling of edge cases
- behavior that differs from surrounding code or established requirements

For PHP, explicitly consider the difference between: null, missing key, empty string '', string '0', integer 0, float 0.0, boolean false, empty array [].

Pay particular attention to truthy/falsy checks such as `if ($value)`. Only flag this when the resulting behavior is actually incorrect or risky.

Check null safety anywhere a value can legitimately be absent, including find(), first(), value(), optional(), ?->, ??, missing array/object keys, empty query results.

Check date handling, including invalid dates, timezone assumptions, boundary dates, start/end-of-day behavior, unexpected date formats.

Check exception handling. Flag exceptions that are incorrectly swallowed or converted into misleading successful results.

B. SECURITY

Check for concrete security vulnerabilities, including missing authentication, missing authorization, broken access control, IDOR/BOLA, exposing another user's/resource's data through caller-controlled IDs, SQL injection, unsafe raw SQL, mass assignment, XSS, unsafe file uploads, path traversal, secrets exposed in code/logs/responses, sensitive PII exposure, trusting client-side validation as a security boundary.

Only report a security issue when the vulnerability is realistically reachable.

C. DATA LOSS / DATA CORRUPTION

Check for UPDATE/DELETE operations with an insufficient WHERE condition, accidental overwrites, destructive operations using untrusted identifiers, partial multi-step writes that require a transaction, incorrect handling of missing records, data corruption caused by incorrect state transitions.

For Laravel, remember: find()/first()/value() may return null; get()/pluck() may return an empty collection. Do not flag these simply because they can return empty results. Flag them only when the code handles those results incorrectly.

D. CONCURRENCY / STATE / IDEMPOTENCY

Consider what happens when operations execute concurrently or more than once. Check for check-then-create race conditions, duplicate jobs, duplicate webhook processing, duplicate payment/event processing, missing idempotency, missing unique constraints, lost updates, stale state, missing database locks where they are actually required, concurrent requests producing inconsistent state.

Do not recommend locks or transactions unless there is a concrete consistency problem to solve.

E. PERFORMANCE / REGRESSIONS

Check for realistic production-impacting problems such as N+1 queries, queries inside loops, unnecessary database queries, loading large datasets into PHP unnecessarily, filtering/counting in PHP when the database can perform it, failure to use appropriate operations such as exists(), count(), value(), or pluck(), missing eager loading, unbounded queries, unnecessary repeated computation, response-shape changes that can break consumers, validation changes that can break existing clients, status-code changes that can break consumers.

Only report performance problems when there is a credible production impact. Do not report theoretical micro-optimizations.

F. TEST COVERAGE

Identify missing tests only when the change introduces a meaningful behavior or regression risk that should have a concrete test. Prefer tests for identified edge cases, regression scenarios, authorization boundaries, concurrency/idempotency behavior, important state transitions. Do not request tests merely because every change could theoretically have one.

G. MAINTAINABILITY / DESIGN

Only after all higher-priority categories have been checked, consider unnecessary complexity, unclear responsibility, duplicated business logic, excessive abstraction, under-engineered large/unstructured logic, meaningful magic values, maintainability risks likely to cause future defects.

Do NOT report personal style preferences, harmless naming differences, formatting, whitespace, subjective refactoring preferences, patterns that the existing codebase already uses consistently.

If a dependency list is provided, check whether the change unnecessarily reimplements functionality already provided by an installed framework/library. If so, report it as a suggestion and name the exact existing API/helper/component that should be used.

3. VALIDATE EVERY FINDING BEFORE REPORTING IT

Before reporting an issue, verify: Is the behavior actually incorrect or materially risky? Is the problem introduced or materially affected by this change? Can you describe a concrete failure scenario? Is there existing validation, authorization, framework behavior, or another layer that prevents the problem? Have you inspected enough surrounding code to support the conclusion? Is the problem important enough to interrupt the developer's review?

If the finding depends on an assumption that cannot be verified, do not present it as a definite bug. Instead, qualify it clearly. When evidence is insufficient, prefer no finding over speculation.

4. ARCHITECTURE / DESIGN

Only recommend architectural changes after understanding the existing system. Do not recommend a pattern simply because it is familiar or considered a best practice. Recommend an architectural change only when the current design creates a concrete problem such as unnecessary coupling, unclear ownership/responsibility, duplicated business logic, significant maintainability risk, a likely future change becoming materially harder, an abstraction that clearly solves no real problem.

5. DO NOT OVER-REPORT

Only report concrete, actionable findings. Do NOT report formatting, whitespace, subjective style, naming preferences, trivial refactoring, hypothetical problems without a credible failure scenario, already-correct code, code outside the changed area unless it is necessary context, generic best-practice violations without a concrete impact, duplicate findings for the same root cause.

Prefer ONE strong finding over multiple weak or overlapping findings. Never invent repository context, framework behavior, requirements, or caller guarantees. If there is nothing worth flagging, return an empty comments array. An empty review is a valid and successful outcome.

6. SEVERITY

Use exactly one of these values:

blocking - Production-breaking behavior, security vulnerability, credible data loss/corruption risk.
issue - Real functional/business-logic bug, real concurrency/state/idempotency problem, major performance problem, major compatibility/regression problem, should be fixed before merge.
suggestion - Worthwhile improvement, not currently a bug, does not materially threaten correctness (e.g. replacing custom logic with an existing installed library/framework API).
nit - Minor maintainability concern, clearly non-blocking, should not delay the PR.

Do not inflate severity.

7. FINDING LOCATION

For every finding: group it under the file it belongs to. line must be a line number shown in that file's diff hunk. Prefer the changed line directly responsible for the problem. Use RIGHT for added/context lines. Use LEFT for removed/original lines. Do not point at an unrelated line merely because it happens to be nearby, and never attribute a finding to the wrong file.

8. OUTPUT FORMAT

For every finding, write "text" as Markdown: one bold headline naming the specific problem, prose explaining the discrepancy, the concrete failure scenario, and if useful a short code block. Keep it tight.

Separately from quoted code, when you have a concrete exact fix for the relevant line(s), set "suggestion" to the exact replacement text. Set "suggestion" to null when the fix is conceptual, requires restructuring, or cannot safely be determined.
"""

REVIEW_PROMPT_LITE = """You are a Senior Software Engineer reviewing changes to one or more files from a production pull request. Each file's unified diff follows on stdin (see the delimiter format below when more than one file is included). Assume it is part of a production Laravel/PHP application unless a file's extension or content clearly indicates another stack.

Perform a risk-focused code review, not a style pass. Do not approve merely because the happy path works.

Check correctness in this priority order:

1. Functional/business-logic bugs - null, empty string, '0', 0, false, empty collection, and boundary-value handling; PHP truthy/falsy pitfalls; unguarded null dereferences; swallowed exceptions or error states; incorrect state transitions, validation, branching, or business rules.

2. Security - authentication/authorization failures; IDOR/BOLA; SQL, command, template, or other injection; mass assignment; XSS; secrets or PII exposure; unsafe file uploads; client-controlled security boundaries.

3. Data loss/corruption - unscoped destructive queries; incorrect updates/deletes; missing transactions where atomicity is required; incorrectly handled empty results.

4. Concurrency/state - race conditions; check-then-act bugs; missing locks where required; missing idempotency; duplicate processing.

5. Performance/regressions - N+1 queries; unbounded queries; missing eager loading; unnecessary repeated calls; materially expensive work; compatibility regressions.

6. Tests - missing tests for meaningful new behavior or regression risk; incorrect tests that fail to cover actual changed behavior.

7. Maintainability (only after higher-risk issues) - unclear naming; unnecessary duplication; over/under-engineering; reinventing framework/dependency functionality.

Validate every finding: do not infer unseen application behavior as fact; do not report issues that are already handled elsewhere in the shown context; if a concern depends on an unverified assumption, state that uncertainty; never report pure style or formatting issues; do not duplicate findings; recommend architectural changes only when there is a concrete coupling, responsibility, or maintenance problem.

If nothing is worth flagging for a file, return an empty comments array for it.

Return ONLY valid JSON:

{
  "files": [
    {
      "path": "string",
      "comments": [
        {
          "line": 123,
          "side": "LEFT" | "RIGHT",
          "severity": "blocking" | "issue" | "suggestion" | "nit",
          "text": "string",
          "suggestion": "string" | null
        }
      ]
    }
  ]
}

Finding rules: line must be an actual line number present in that file's supplied diff. side must be LEFT or RIGHT. Prefer RIGHT for introduced problems. text must contain a bold headline, brief explanation, and concrete failure scenario. suggestion must be exact replacement code when a safe local replacement exists.
"""

SUMMARY_PROMPT = """A unified diff for a full GitHub pull request follows on stdin. You are the same senior reviewer providing the overall orientation shown to a reviewer before they read the diff and before per-file inline findings.

Reason through the PR as a whole before writing the output.

Your internal reasoning should cover: intent and scope; risk; cross-file correctness; tests; final merge gate.

Write summary as exactly:

"Verdict: <VERDICT> - <2-4 plain-English sentences>"

Where VERDICT is exactly one of: APPROVE, APPROVE WITH MINOR CHANGES, CHANGES REQUESTED, BLOCK.

Do not repeat inline findings mechanically.

Also fill checklist with exactly one entry for every configured checklist item.

For each checklist item: status must be pass, warning, or unchecked. pass means applicable, reviewed, and no concern. warning means applicable and a genuine concern exists. unchecked means it does not meaningfully apply. Do not guess or force a verdict for a stack not touched by the diff.

Each note must be exactly one short, specific sentence grounded in the actual diff.

Return ONLY valid JSON.
"""

# ---------------------------------------------------------------------------
# Frontend/backend addenda
# ---------------------------------------------------------------------------

CODEBASE_CONTEXT_ADDENDUM = """

The full repository (at the PR's head commit) is checked out at your current working directory - you have Read, Grep, and Glob available to consult it.

Use them where they'd materially change your review:
- how a changed function/export is called elsewhere
- whether a change matches existing conventions
- related types/config the diff doesn't show

Stay targeted. Look at this file and things it directly references/imports; do not perform an open-ended repository crawl.
"""


def _linked_pr_addendum(linked_context: str | None) -> str:
    if not linked_context:
        return ""

    return f"""

The following PR(s) are linked to this one as related/dependent changes.

Use them only as context for reviewing THIS PR's diff, especially cross-PR consistency such as:
- function signatures
- API response shapes
- exported names
- configuration keys
- shared types

Do not report bugs that exist purely within the linked PR.

{linked_context}
"""


def _curated_context_addendum(curated_context: str | None) -> str:
    if not curated_context:
        return ""

    return f"""

The following additional repository files were selected because they reference files this diff changes.

Use them only to understand how the changed code is actually used elsewhere. Do not report bugs in this additional code itself.

{curated_context}
"""


BATCH_INPUT_ADDENDUM = """

One or more files' changes are provided together on stdin, delimited as:

--- FILE: <path> ---
<unified diff for that file>

Review each file independently based on its own diff - do not let one file's changes affect your correctness findings about another file, except when a finding is explicitly about cross-file consistency between files both shown here.

For every file delimited above, return exactly one entry in "files" keyed by that exact path, even when the file has no findings (return an empty "comments" array for it in that case). Never omit a provided file and never invent a path that was not shown.
"""

FRONTEND_REVIEW_ADDENDUM = """

This file is frontend/UI code.

Project convention:
- If this is a genuinely new application/component JavaScript source file (.js/.jsx), flag it as an issue because new frontend application/source files must be TypeScript.
- Do not apply that rule to renames/moves.
- Do not apply it to normal tooling/configuration files such as vite.config.js, tailwind.config.js, postcss.config.js, or eslint configuration.
- Use judgment.

Prioritize: functional/UI correctness; loading, empty, success, and error states; slow network, API failure, double-click, retry, and navigation; duplicate submissions; stale async state; React effect dependencies and cleanup where applicable; API/data contracts; security; accessibility; performance; responsive behavior; meaningful tests; maintainability and reuse of existing project capabilities.

Do not flag subjective aesthetics without a concrete design/spec requirement.
"""

BACKEND_NEW_FILE_ADDENDUM = """

This file is backend/server-side code.

If it is genuinely new behavioral code, perform one additional low-level object-design review.

Consider actual GoF/object-level patterns such as: Repository, Factory, Builder, Strategy, Observer, Decorator, Adapter, Command, Template Method, Facade, Singleton.

Do not recommend a pattern merely because it exists.

If there is a meaningful LLD/design issue:
- Add exactly one additional comment.
- Name the recognizable pattern currently used, if any.
- Explain the concrete consequence.
- Name a different pattern only when it genuinely improves this responsibility.

Use severity suggestion for worthwhile design improvements and issue only for concrete design problems.

Never invent a design issue merely to satisfy this addendum.
"""

# ---------------------------------------------------------------------------
# Checklist / schemas
# ---------------------------------------------------------------------------

CHECKLIST_ITEMS = checklist_items()
CHECKLIST_ITEM_IDS = [item["id"] for item in CHECKLIST_ITEMS]

# Shared shape for one finding. "file" is deliberately not part of this —
# batch calls key comments by the enclosing file's path (see _batch_schema)
# instead of asking the model to repeat it on every single comment.
_COMMENT_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "line": {"type": "number"},
        "side": {
            "type": "string",
            "enum": ["LEFT", "RIGHT"],
        },
        "text": {"type": "string"},
        "severity": {
            "type": "string",
            "enum": ["nit", "suggestion", "issue", "blocking"],
        },
        "suggestion": {
            "type": ["string", "null"],
        },
    },
    "required": ["line", "side", "text", "severity", "suggestion"],
}


# One review call now covers a batch of files (see _group_into_batches), not
# a single file — this schema is built per call so "path" can be constrained
# to an enum of exactly the files in that batch, and the array length can be
# pinned to that same count. That gives the model a hard contract to return
# one entry per input file (an empty "comments" array for a clean file), so a
# file that's missing from the response is distinguishable from a file that
# was reviewed and had nothing to flag.
def _batch_schema(paths: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "files": {
                "type": "array",
                "minItems": len(paths),
                "maxItems": len(paths),
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "enum": paths},
                        "comments": {"type": "array", "items": _COMMENT_ITEM_SCHEMA},
                    },
                    "required": ["path", "comments"],
                },
            },
        },
        "required": ["files"],
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
                    "id": {
                        "type": "string",
                        "enum": CHECKLIST_ITEM_IDS,
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pass", "warning", "unchecked"],
                    },
                    "note": {"type": "string"},
                },
                "required": ["id", "status", "note"],
            },
        },
    },
    "required": ["summary", "checklist"],
}

# Serialize once rather than rebuilding the schema JSON on every call.
SUMMARY_SCHEMA_JSON = json.dumps(SUMMARY_SCHEMA, separators=(",", ":"))

# ---------------------------------------------------------------------------
# Stable prompt cache
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT_CACHE_DIR = Path(tempfile.gettempdir()) / "pr-review-studio-system-prompts"


def _system_prompt_file_for(prompt: str) -> str:
    _SYSTEM_PROMPT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
    path = _SYSTEM_PROMPT_CACHE_DIR / f"{digest}.txt"

    if not path.exists():
        tmp_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp_path.write_text(prompt, encoding="utf-8")
        os.replace(tmp_path, path)

    return str(path)


_NEUTRAL_CWD = Path(tempfile.gettempdir()) / "pr-review-studio-neutral-cwd"

# ---------------------------------------------------------------------------
# Global Claude concurrency
# ---------------------------------------------------------------------------
# One limiter for ALL Claude CLI processes, including the deep summary call.
# This prevents deep mode from effectively running REVIEW_CONCURRENCY + 1
# processes.

_CLAUDE_SEMAPHORE: asyncio.Semaphore | None = None


def _claude_semaphore() -> asyncio.Semaphore:
    global _CLAUDE_SEMAPHORE

    if _CLAUDE_SEMAPHORE is None:
        _CLAUDE_SEMAPHORE = asyncio.Semaphore(REVIEW_CONCURRENCY)

    return _CLAUDE_SEMAPHORE


# ---------------------------------------------------------------------------
# Claude invocation
# ---------------------------------------------------------------------------

async def _run_claude_call(
    prompt: str,
    stdin_text: str,
    schema_json: str,
    cwd: str | None = None,
    tools: str | None = None,
    use_system_prompt: bool = True,
    context_text: str = "",
) -> tuple[dict[str, Any], dict[str, float | int]]:
    args = [
        "-p",
        "--output-format",
        "json",
        "--model",
        REVIEW_MODEL,
        "--json-schema",
        schema_json,
    ]

    if tools:
        args += [
            "--tools",
            tools,
            "--permission-mode",
            "bypassPermissions",
        ]
    else:
        args += ["--tools", ""]

    diff_block = "--- BEGIN DIFF ---\n" f"{stdin_text}\n" "--- END DIFF ---"

    body = f"{context_text}\n\n{diff_block}" if context_text else diff_block

    if use_system_prompt:
        args += [
            "--system-prompt-file",
            _system_prompt_file_for(prompt),
        ]
        stdin_payload = body
    else:
        stdin_payload = f"{prompt}\n\n{body}"

    _NEUTRAL_CWD.mkdir(parents=True, exist_ok=True)

    semaphore = _claude_semaphore()

    async with semaphore:
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                [claude_cli_path(), *args],
                cwd=cwd or str(_NEUTRAL_CWD),
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
        detail = stderr or stdout or "no output on stdout or stderr"

        raise RuntimeError(
            f"claude CLI exited with code {result.returncode}: {detail[:2000]}"
        )

    return _parse_envelope(result.stdout.decode("utf-8", errors="replace"))


# ---------------------------------------------------------------------------
# Batched file review
# ---------------------------------------------------------------------------
#
# One Claude call now reviews a BATCH of changed files, not a single file.
# Reviewing one file per call was found to cost ~10-15x what a single
# whole-diff CLI review of the same PR costs, because every call pays its
# own fixed overhead (system-prompt cache read, --json-schema, a full
# structured response — even a "no findings" one) independent of that file's
# actual size. Batching turns N per-file calls into M << N per-batch calls,
# which removes that duplicated fixed cost directly instead of just capping
# around it (see review_max_tokens). See _group_into_batches for how batches
# are formed.

BATCH_MAX_FILES = batch_max_files()
BATCH_MAX_DIFF_TOKENS = batch_max_diff_tokens()


def _group_into_batches(
    chunks: list[dict[str, Any]], repo_name: str
) -> list[list[dict[str, Any]]]:
    """
    Groups changed-file chunks into per-call batches.

    Grouped by addendum variant (frontend/backend/asset) first, so every
    file in a batch shares the same static prompt/addenda and prompt-cache
    key; within a variant, split by file count (BATCH_MAX_FILES) and
    estimated diff size (BATCH_MAX_DIFF_TOKENS) so no single call grows
    unbounded on a PR with many large files of the same variant.
    """
    by_variant: dict[str, list[dict[str, Any]]] = {}
    for chunk in chunks:
        variant = _addendum_variant(chunk["path"], repo_name)
        by_variant.setdefault(variant, []).append(chunk)

    batches: list[list[dict[str, Any]]] = []

    for group in by_variant.values():
        current: list[dict[str, Any]] = []
        current_tokens = 0

        for chunk in group:
            tokens = _estimate_chunk_diff_tokens(chunk)

            if current and (
                len(current) >= BATCH_MAX_FILES
                or current_tokens + tokens > BATCH_MAX_DIFF_TOKENS
            ):
                batches.append(current)
                current = []
                current_tokens = 0

            current.append(chunk)
            current_tokens += tokens

        if current:
            batches.append(current)

    return batches


def _batch_file_label(chunk: dict[str, Any]) -> str:
    return chunk["path"] or "(unknown file)"


async def _run_batch_review(
    batch: list[dict[str, Any]],
    cwd: str | None,
    repo_name: str,
    dep_context: str | None,
    phpstan_context: str | None,
    linked_context: str | None,
    curated_context: str | None,
) -> tuple[list[dict[str, Any]], dict[str, float | int]]:
    # Every chunk in a batch shares one addendum variant by construction
    # (see _group_into_batches), so classifying off the first file is safe.
    variant = _addendum_variant(batch[0]["path"], repo_name)
    is_frontend = variant == "frontend"

    frontend_addendum = FRONTEND_REVIEW_ADDENDUM if is_frontend else ""
    backend_addendum = BACKEND_NEW_FILE_ADDENDUM if variant == "backend" else ""
    tools_addendum = CODEBASE_CONTEXT_ADDENDUM if cwd else ""
    review_prompt = REVIEW_PROMPT_FULL if cwd else REVIEW_PROMPT_LITE

    manifest_addendum = ""

    if variant != "asset":
        manifest_addendum = (dep_context or "") if is_frontend else (phpstan_context or "")

    linked_curated_addendum = (
        f"{_linked_pr_addendum(linked_context)}"
        f"{_curated_context_addendum(curated_context)}"
    )

    # IMPORTANT:
    #
    # Deep mode now also uses the stable system-prompt cache. The
    # repository-specific environment remains represented by cwd + tools,
    # while the large static review instructions are placed behind a
    # reusable prompt-cache boundary.
    #
    # We intentionally do not inject curated_context into deep mode because
    # Claude can inspect the repository itself. This avoids paying for the
    # same context twice.
    static_prompt = f"{review_prompt}{BATCH_INPUT_ADDENDUM}{frontend_addendum}{backend_addendum}{tools_addendum}"

    # PR-specific context (dependency manifest, PHPStan config, linked PRs,
    # curated files) goes in the USER turn — never appended to static_prompt.
    #
    # This keeps static_prompt byte-identical across PRs: at most 3 distinct
    # system prompts per mode (frontend / backend / asset) for the life of
    # the process, instead of a fresh one per PR.
    #
    # Be clear about what this does and does not buy TODAY: through the
    # `claude` CLI it is cost-neutral, because the CLI caches the system
    # prompt in the same block as the piped user turn, so the varying diff
    # invalidates it either way (see the module docstring for the measured
    # numbers). What it does buy now is that _system_prompt_file_for() stops
    # writing a new temp file for every PR forever. What it buys later is the
    # actual saving: a stable system prompt is the precondition for putting a
    # real cache_control breakpoint after it once reviews move to the
    # Messages API. Do not re-inline per-PR context here.
    context_text = (
        manifest_addendum if cwd else f"{manifest_addendum}{linked_curated_addendum}"
    )

    labels = [_batch_file_label(chunk) for chunk in batch]
    stdin_text = "\n\n".join(
        f"--- FILE: {label} ---\n{chunk['text']}" for label, chunk in zip(labels, batch)
    )
    schema_json = json.dumps(_batch_schema(labels), separators=(",", ":"))

    parsed, usage = await _run_claude_call(
        static_prompt,
        stdin_text,
        schema_json,
        cwd=cwd,
        tools=("Read,Grep,Glob" if cwd else None),
        use_system_prompt=True,
        context_text=context_text,
    )

    by_label = {entry["path"]: entry["comments"] for entry in parsed.get("files", [])}
    comments: list[dict[str, Any]] = []

    for label in labels:
        file_comments = by_label.get(label)

        if file_comments is None:
            logger.warning(
                "Batch review response missing file %r - treating as no findings", label
            )
            file_comments = []

        comments.extend(file_comments)

    return comments, usage


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

async def _run_summary(
    diff_text: str,
    linked_context: str | None,
    curated_context: str | None,
) -> tuple[str, list[dict[str, str]], dict[str, float | int]]:
    # Summary still receives the full diff because it is explicitly
    # responsible for cross-file reasoning.
    #
    # SUMMARY_PROMPT is passed alone so the cached system prompt stays
    # byte-identical across every review; the per-PR linked/curated context
    # rides in the user turn instead. Appending it here used to give the
    # summary call a fresh cache key on every single PR — see the note in
    # _run_batch_review for the measured cost of that.
    parsed, usage = await _run_claude_call(
        SUMMARY_PROMPT,
        diff_text,
        SUMMARY_SCHEMA_JSON,
        use_system_prompt=True,
        context_text=(
            f"{_linked_pr_addendum(linked_context)}"
            f"{_curated_context_addendum(curated_context)}"
        ),
    )

    return parsed["summary"], parsed.get("checklist") or [], usage


# ---------------------------------------------------------------------------
# Usage accounting
# ---------------------------------------------------------------------------

ZERO_USAGE: dict[str, float | int] = {
    "costUsd": 0.0,
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0,
}


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


def _total_tokens(usage: dict[str, float | int]) -> int:
    return int(
        usage.get("inputTokens", 0)
        + usage.get("outputTokens", 0)
        + usage.get("cacheReadInputTokens", 0)
        + usage.get("cacheCreationInputTokens", 0)
    )


# ---------------------------------------------------------------------------
# Token-budget scheduling
# ---------------------------------------------------------------------------

_ESTIMATE_CHARS_PER_TOKEN = estimate_chars_per_token()
_ESTIMATE_RESERVE_TOKENS = estimate_reserve_tokens()


def _estimate_chunk_diff_tokens(chunk: dict[str, Any]) -> int:
    """
    Estimated size of ONE file's diff, in tokens. No answer reserve.

    The chars-per-token ratio (estimateCharsPerToken, review_config.json) is
    intentionally conservative enough for source code while remaining cheap.
    """
    text = chunk.get("text") or ""
    return max(256, len(text) // _ESTIMATE_CHARS_PER_TOKEN)


def _estimate_batch_tokens(batch: list[dict[str, Any]]) -> int:
    """
    Conservative token estimate for one Claude CALL, used only for scheduling.

    This does NOT replace actual usage accounting. It prevents an obviously
    oversized batch from being launched when very little budget remains.

    estimateReserveTokens is added ONCE per batch, not once per file: it
    reserves room for the model's answer/tool activity for this call, and a
    call produces one answer no matter how many files it covers.

    Getting that wrong was expensive. The reserve used to be baked into the
    per-chunk estimate, so it was multiplied by the file count and charged
    against batchMaxDiffTokens — a knob whose name and docs say it measures
    *diff* size. With the defaults (4,000 reserve, 20,000 cap) that capped a
    batch at 4 files regardless of how small they were, making batchMaxFiles
    (7) dead config and forcing ~75% more calls than intended. Each extra
    call costs a full ~10,186-token fixed overhead (see module docstring),
    which dwarfs anything the reserve was protecting against.
    """
    return (
        sum(_estimate_chunk_diff_tokens(chunk) for chunk in batch)
        + _ESTIMATE_RESERVE_TOKENS
    )


# ---------------------------------------------------------------------------
# Review orchestration
# ---------------------------------------------------------------------------

async def run_review(
    diff: str,
    mode: str = "diff",
    cwd: str | None = None,
    repo_name: str = "",
    linked_context: str | None = None,
    curated_context: str | None = None,
    dep_context: str | None = None,
    phpstan_context: str | None = None,
) -> dict[str, Any]:
    chunks = [
        chunk
        for chunk in split_diff_by_file(diff)
        if not _is_trivial_chunk(chunk["path"], chunk["text"])
    ]

    summary_task: asyncio.Task | None = None

    if mode == "deep":
        # _run_summary itself uses the global Claude semaphore, so this no
        # longer creates an extra process outside REVIEW_CONCURRENCY.
        summary_task = asyncio.ensure_future(
            _run_summary(diff, linked_context, curated_context)
        )

    # Files are grouped into batches (see _group_into_batches) so each Claude
    # call reviews several files at once instead of one call per file - the
    # fixed per-call overhead (cached system prompt, schema, a full
    # structured response) no longer scales with file count.
    batches = _group_into_batches(chunks, repo_name)

    per_batch_comments: list[list[dict[str, Any]] | None] = [None] * len(batches)
    per_batch_usage: list[dict[str, float | int] | None] = [None] * len(batches)

    indexed_batches = list(enumerate(batches))

    async def review_one(item: tuple[int, list[dict[str, Any]]], _local_i: int) -> None:
        i, batch = item

        comments, usage = await _run_batch_review(
            batch,
            cwd,
            repo_name,
            dep_context,
            phpstan_context,
            linked_context,
            curated_context,
        )

        per_batch_comments[i] = comments
        per_batch_usage[i] = usage

    max_tokens = review_max_tokens(mode)
    spent_tokens = 0

    # ------------------------------------------------------------------
    # Diff/curated prompt-cache priming
    # ------------------------------------------------------------------
    #
    # WARNING — measured to buy nothing through the `claude` CLI. Verified on
    # this machine: the CLI exposes only ONE stable cache breakpoint, ~1,442
    # tokens into its own preamble. Everything after it — the rest of the
    # Claude Code harness, our --system-prompt-file content, AND the piped
    # user turn — is cached as a single block, so a differing diff
    # invalidates the system prompt too. Three calls sharing one identical
    # system-prompt file but different diffs each reported
    # cacheCreate=8744 / cacheRead=1442: the primed entry is never read back.
    #
    # Priming is therefore latency-only overhead here (it serializes one
    # batch ahead of the rest for no cache benefit). It is left in place, and
    # deliberately NOT extended to deep mode, because it becomes correct and
    # necessary the moment reviews move off the CLI onto the Messages API
    # with an explicit cache_control breakpoint after the system prompt —
    # which is where the real saving lives. See the module docstring.
    #
    # Primers are not a separate review phase: each one is a real batch
    # review whose findings are kept, submitted through the same semaphore.
    #
    # We also skip priming if there is no budget available.

    pending_batches = indexed_batches

    if (
        cwd is None
        and len(indexed_batches) > 1
        and (max_tokens is None or spent_tokens < max_tokens)
    ):
        seen_variants: set[str] = set()
        primers: list[tuple[int, list[dict[str, Any]]]] = []

        for item in indexed_batches:
            _, batch = item
            variant = _addendum_variant(batch[0]["path"], repo_name)

            if variant in seen_variants:
                continue

            seen_variants.add(variant)
            primers.append(item)

        # Primers are unavoidable review calls. If a token budget is
        # configured, only launch primers while there is remaining
        # estimated budget.
        primer_batch: list[tuple[int, list[dict[str, Any]]]] = []
        estimated_remaining = max_tokens if max_tokens is not None else None

        for item in primers:
            if (
                estimated_remaining is not None
                and primer_batch
                and _estimate_batch_tokens(item[1]) > estimated_remaining
            ):
                break

            primer_batch.append(item)

            if estimated_remaining is not None:
                estimated_remaining -= _estimate_batch_tokens(item[1])

        if primer_batch:
            await map_with_concurrency(primer_batch, REVIEW_CONCURRENCY, review_one)

            primer_indices = {i for i, _ in primer_batch}

            spent_tokens += sum(
                _total_tokens(per_batch_usage[i] or {}) for i in primer_indices
            )

            pending_batches = [
                item for item in indexed_batches if item[0] not in primer_indices
            ]

    # ------------------------------------------------------------------
    # Main batch processing
    # ------------------------------------------------------------------

    if max_tokens is not None:
        # No fixed group size beyond BATCH_MAX_FILES/BATCH_MAX_DIFF_TOKENS:
        # every worker (bounded by REVIEW_CONCURRENCY, via map_with_concurrency)
        # checks spent_tokens against the budget right before pulling its next
        # batch, instead of committing to a fixed-size group of batches and only
        # reconciling after it finishes. That bounds how far the budget can be
        # overshot to at most REVIEW_CONCURRENCY batches in flight when the
        # threshold is crossed.
        skipped_batches = 0
        skipped_files = 0

        async def review_one_gated(item: tuple[int, list[dict[str, Any]]], local_i: int) -> None:
            nonlocal spent_tokens, skipped_batches, skipped_files

            if spent_tokens >= max_tokens:
                skipped_batches += 1
                skipped_files += len(item[1])
                return

            await review_one(item, local_i)

            i, _ = item
            spent_tokens += _total_tokens(per_batch_usage[i] or {})

        await map_with_concurrency(pending_batches, REVIEW_CONCURRENCY, review_one_gated)

        if skipped_batches:
            logger.warning(
                "%s review token budget (%d) reached after %d/%d files reviewed "
                "- skipped %d file(s) across %d batch(es)",
                mode,
                max_tokens,
                len(chunks) - skipped_files,
                len(chunks),
                skipped_files,
                skipped_batches,
            )

    else:
        await map_with_concurrency(pending_batches, REVIEW_CONCURRENCY, review_one)

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------

    if summary_task is not None:
        summary, checklist, summary_usage = await summary_task
    else:
        summary = ""
        checklist = []
        summary_usage = ZERO_USAGE

    comments = [comment for group in per_batch_comments for comment in (group or [])]

    usage = sum_usage(
        [
            summary_usage,
            *(usage for usage in per_batch_usage if usage),
        ]
    )

    return {
        "summary": summary,
        "checklist": checklist,
        "comments": comments,
        "usage": usage,
    }


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------

VALID_SEVERITIES = {"nit", "suggestion", "issue", "blocking"}


def _parse_envelope(stdout: str) -> tuple[dict[str, Any], dict[str, float | int]]:
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError as err:
        raise RuntimeError(
            f"claude CLI did not return a valid JSON envelope: {stdout[:500]}"
        ) from err

    if envelope.get("is_error"):
        raise RuntimeError(
            f"claude CLI reported an error: {envelope.get('result') or stdout[:500]}"
        )

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

    def _coerce_comment(comment: Any, file_path: str) -> dict[str, Any] | None:
        if not (isinstance(comment, dict) and isinstance(comment.get("text"), str)):
            return None

        return {
            "file": file_path,
            "line": _coerce_line(comment.get("line")),
            "side": "LEFT" if comment.get("side") == "LEFT" else "RIGHT",
            "text": comment["text"],
            "severity": (
                comment.get("severity")
                if comment.get("severity") in VALID_SEVERITIES
                else "suggestion"
            ),
            "suggestion": _coerce_suggestion(comment.get("suggestion")),
        }

    if isinstance(structured.get("files"), list):
        result["files"] = [
            {
                "path": entry["path"],
                "comments": [
                    comment
                    for raw in (entry.get("comments") or [])
                    if (comment := _coerce_comment(raw, entry["path"])) is not None
                ],
            }
            for entry in structured["files"]
            if isinstance(entry, dict) and isinstance(entry.get("path"), str)
        ]

    if isinstance(structured.get("summary"), str):
        result["summary"] = structured["summary"].strip()

        raw_checklist = structured.get("checklist")

        checklist_by_id = (
            {item.get("id"): item for item in raw_checklist if isinstance(item, dict)}
            if isinstance(raw_checklist, list)
            else {}
        )

        result["checklist"] = [
            {
                "id": item["id"],
                "label": item["label"],
                "group": item["group"],
                "status": _coerce_checklist_status(
                    (checklist_by_id.get(item["id"]) or {}).get("status")
                ),
                "note": _coerce_checklist_note(
                    (checklist_by_id.get(item["id"]) or {}).get("note")
                ),
            }
            for item in CHECKLIST_ITEMS
        ]

    if "files" not in result and "summary" not in result:
        raise RuntimeError(
            'claude CLI response had no structured "files" or "summary": '
            f"{stdout[:500]}"
        )

    return result, usage