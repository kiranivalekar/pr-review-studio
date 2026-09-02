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
from app.config import checklist_items, claude_cli_path, review_chunk_size, review_concurrency, review_max_tokens

logger = logging.getLogger(__name__)

REVIEW_CONCURRENCY = review_concurrency()

# Files where a per-line review is never useful — skipping them means fewer, faster
# claude calls with no loss in review quality. Path check is deliberately loose (matches
# anywhere in the path) since these show up nested under workspace subfolders too.
TRIVIAL_PATH_RE = re.compile(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock)$")
GENERATED_PATH_RE = re.compile(r"(^|/)(dist|build|vendor|node_modules)/")
MINIFIED_OR_MAP_RE = re.compile(r"\.(min\.js|min\.css|map)$")

# Extension-based heuristic for "this file is frontend/UI code" — unambiguous for these
# extensions, so FRONTEND_REVIEW_ADDENDUM always applies regardless of repo. .js/.ts alone
# are the ambiguous case (could be a Node backend file) — resolved by _classify_frontend()
# below using the repo's own name instead of guessing per file. FRONTEND_REPO_NAMES and
# BACKEND_REPO_NAMES are this org's actual repos, listed explicitly rather than inferred
# from a "front" substring — that heuristic alone gets odyssey-frontdoor (a backend repo)
# wrong. An unlisted repo not in either set still falls back to the substring guess.
FRONTEND_UNAMBIGUOUS_RE = re.compile(r"\.(jsx|tsx|vue|svelte|css|scss|sass|less|html?)$", re.IGNORECASE)
AMBIGUOUS_SCRIPT_RE = re.compile(r"\.(js|ts)$", re.IGNORECASE)
REPO_FRONTEND_NAME_RE = re.compile(r"front", re.IGNORECASE)
FRONTEND_REPO_NAMES = {
    "gfs-saas-agent-portal-front",
    "gfs-saas-front",
    "gfs-saas-instantquote-front",
    "gfs-saas-policyholder-portal-front",
    "odyssey-charts-ui",
    "odyssey-shared-ui",
}
BACKEND_REPO_NAMES = {
    "gfs-saas-accounting",
    "gfs-saas-agent-portal",
    "gfs-saas-auth",
    "gfs-saas-claim",
    "gfs-saas-core",
    "gfs-saas-forms",
    "gfs-saas-infra",
    "gfs-saas-instantquote",
    "gfs-saas-odyssey-api",
    "gfs-saas-policy",
    "gfs-saas-producer",
    "gfs-saas-routeql",
    "job-tracker",
    "odyssey-frontdoor",
    "taurus-api-testing",
    "taurus-reports-service",
}


# repo_name is the bare repo name (not "owner/repo"). Only resolves the .js/.ts ambiguity —
# an unambiguous extension (.jsx, .css, etc.) is always frontend no matter what the repo is
# named, so a mixed Laravel+Vite repo's actual frontend files still get the right addendum.
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


# Full instructions — used only in deep mode (cwd set, Read/Grep/Glob available), where
# the model can actually act on "check how this is used elsewhere" and similar guidance
# that's meaningless without tool access. diff/curated mode uses REVIEW_PROMPT_LITE below
# instead: a condensed version of the same priority order and output-format rules, cut to
# a fraction of the length since caching doesn't reduce this cost (see _run_claude_call) —
# shorter text is the only lever left that actually cuts tokens for the common case.
REVIEW_PROMPT_FULL = """You are a Senior Software Engineer, Technical Lead, and production Code Reviewer.

You are reviewing ONE FILE'S changes from a larger production pull request. A unified diff for this single file is provided on stdin.

Assume the project is a production Laravel/PHP application unless the file extension or content clearly indicates another stack. Apply equivalent scrutiny for other stacks.

Your job is to identify REAL, ACTIONABLE problems introduced or materially affected by this change. This is a risk-focused code review, NOT a syntax, formatting, or style review.

Follow the review process below in order.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. UNDERSTAND THE EXISTING CODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. REVIEW CORRECTNESS — IN THIS PRIORITY ORDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

For PHP, explicitly consider the difference between:
- null
- missing key
- empty string `''`
- string `'0'`
- integer `0`
- float `0.0`
- boolean `false`
- empty array `[]`

Pay particular attention to truthy/falsy checks such as:

```php
if ($value)
```

Only flag this when the resulting behavior is actually incorrect or risky.

Check null safety anywhere a value can legitimately be absent, including:
- find()
- first()
- value()
- optional()
- ?->
- ??
- missing array/object keys
- empty query results

Check date handling, including:
- invalid dates
- timezone assumptions
- boundary dates
- start/end-of-day behavior
- unexpected date formats

Check exception handling. Flag exceptions that are incorrectly swallowed or converted into misleading successful results, for example:

```php
catch (\\Throwable) {
    return [];
}
```

when this can hide a real production failure.

B. SECURITY

Check for concrete security vulnerabilities, including:
- missing authentication
- missing authorization
- broken access control
- IDOR/BOLA
- exposing another user's/resource's data through caller-controlled IDs
- SQL injection
- unsafe raw SQL
- mass assignment
- XSS
- unsafe file uploads
- path traversal
- secrets exposed in code, logs, or responses
- sensitive PII exposure
- trusting client-side validation as a security boundary

Only report a security issue when the vulnerability is realistically reachable.

C. DATA LOSS / DATA CORRUPTION

Check for:
- UPDATE/DELETE operations with an insufficient WHERE condition
- accidental overwrites
- destructive operations using untrusted identifiers
- partial multi-step writes that require a transaction
- incorrect handling of missing records
- incorrect assumptions about uniqueness
- data corruption caused by incorrect state transitions

For Laravel, remember:
- find() / first() / value() may return null
- get() / pluck() may return an empty collection

Do not flag these simply because they can return empty results. Flag them only when the code handles those results incorrectly.

D. CONCURRENCY / STATE / IDEMPOTENCY

Consider what happens when operations execute concurrently or more than once.

Check for:
- check-then-create race conditions
- duplicate jobs
- duplicate webhook processing
- duplicate payment/event processing
- missing idempotency
- missing unique constraints
- lost updates
- stale state
- missing database locks where they are actually required
- concurrent requests producing inconsistent state

Do not recommend locks or transactions unless there is a concrete consistency problem to solve.

E. PERFORMANCE / REGRESSIONS

Check for realistic production-impacting problems such as:
- N+1 queries
- queries inside loops
- unnecessary database queries
- loading large datasets into PHP unnecessarily
- filtering/counting in PHP when the database can perform it
- failure to use appropriate operations such as exists(), count(), value(), or pluck()
- missing eager loading
- unbounded queries
- unnecessary repeated computation
- response-shape changes that can break consumers
- validation changes that can break existing clients
- status-code changes that can break consumers

Only report performance problems when there is a credible production impact.

Do not report theoretical micro-optimizations.

F. TEST COVERAGE

Identify missing tests only when the change introduces a meaningful behavior or regression risk that should have a concrete test.

Prefer tests for:
- identified edge cases
- regression scenarios
- authorization boundaries
- concurrency/idempotency behavior
- important state transitions

Do not request tests merely because every change could theoretically have one.

G. MAINTAINABILITY / DESIGN

Only after all higher-priority categories have been checked, consider:
- unnecessary complexity
- unclear responsibility
- duplicated business logic
- excessive abstraction
- under-engineered large/unstructured logic
- meaningful magic values
- maintainability risks likely to cause future defects

Do NOT report:
- personal style preferences
- harmless naming differences
- formatting
- whitespace
- subjective refactoring preferences
- patterns that the existing codebase already uses consistently

If a dependency list is provided, check whether the change unnecessarily reimplements functionality already provided by an installed framework/library.

If so, report it as a suggestion and name the exact existing API/helper/component that should be used.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. VALIDATE EVERY FINDING BEFORE REPORTING IT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before reporting an issue, verify:
- Is the behavior actually incorrect or materially risky?
- Is the problem introduced or materially affected by this change?
- Can you describe a concrete failure scenario?
- Is there existing validation, authorization, framework behavior, or another layer that prevents the problem?
- Have you inspected enough surrounding code to support the conclusion?
- Is the problem important enough to interrupt the developer's review?

If the finding depends on an assumption that cannot be verified, do not present it as a definite bug.

Instead, qualify it clearly, for example:

"If X can be null here, this breaks Y. If the caller guarantees non-null, this is not an issue."

When evidence is insufficient, prefer no finding over speculation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. ARCHITECTURE / DESIGN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Only recommend architectural changes after understanding the existing system.

Do not recommend a pattern simply because it is familiar or considered a best practice.

Recommend an architectural change only when the current design creates a concrete problem such as:
- unnecessary coupling
- unclear ownership/responsibility
- duplicated business logic
- significant maintainability risk
- a likely future change becoming materially harder
- an abstraction that clearly solves no real problem

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. DO NOT OVER-REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Only report concrete, actionable findings.

Do NOT report:
- formatting
- whitespace
- subjective style
- naming preferences
- trivial refactoring
- hypothetical problems without a credible failure scenario
- already-correct code
- code outside the changed area unless it is necessary context
- generic best-practice violations without a concrete impact
- duplicate findings for the same root cause

Prefer ONE strong finding over multiple weak or overlapping findings.

Never invent repository context, framework behavior, requirements, or caller guarantees.

If there is nothing worth flagging, return an empty comments array.

An empty review is a valid and successful outcome.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. SEVERITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use exactly one of these values:

blocking
- Production-breaking behavior
- Security vulnerability
- Credible data loss/corruption risk

issue
- Real functional/business-logic bug
- Real concurrency/state/idempotency problem
- Major performance problem
- Major compatibility/regression problem
- Should be fixed before merge

suggestion
- Worthwhile improvement
- Not currently a bug
- Does not materially threaten correctness
- Example: replacing custom logic with an existing installed library/framework API

nit
- Minor maintainability concern
- Clearly non-blocking
- Should not delay the PR

Do not inflate severity.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. FINDING LOCATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For every finding:
- file must be the changed file path.
- line must be a line number shown in the diff hunk.
- Prefer the changed line directly responsible for the problem.
- Use RIGHT for added/context lines.
- Use LEFT for removed/original lines.

Do not point at an unrelated line merely because it happens to be nearby — point at the exact line where the problem actually occurs, even when the underlying cause traces back to a different changed line in the same hunk.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For every finding, write "text" as Markdown, rendered directly to the reviewer, in this shape:
- One bold headline naming the specific problem — e.g. "**Rejected dispatch promises never trigger the fallback**", not a vague label like "bug" or "issue here."
- Prose explaining the discrepancy: what the surrounding code, comment, spec, or existing convention implies vs. what the code actually does. Quote the exact current code relevant to the finding in a fenced code block (with a language tag matching the file) only when quoting it makes the problem clearer than prose alone.
- The concrete failure scenario: what input, timing, or condition actually triggers it.
- If there is an alternative approach worth showing beyond a single-line drop-in fix — it needs restructuring, not just a line swap — show it as a second fenced code block introduced by a short line such as "I'd do:" or "Consider:".

Keep it tight: a few sentences and at most two short code quotes, not an essay — this is a review comment, not documentation.

Mention a concrete strength only when genuinely notable (e.g. "good use of a DB transaction here") — never generic praise, and never as its own comment separate from an actual finding.

Separately from any code quoted inside "text", when you have a concrete, exact code fix in mind for that specific line (or lines), also set "suggestion" to the exact replacement text — matching the original indentation, no diff markers (+/-), no explanation, just the code that should replace what's there, ready to drop in as-is. Set "suggestion" to null when the comment is conceptual (a question, a design concern, something needing a bigger rework, a missing test, or a migration/deployment/rollback risk) rather than a specific line-level edit — an illustrative alternative shown inside "text" doesn't need a matching "suggestion"."""

# Condensed version of the above — same priority order and output-format rules, same
# severity/suggestion semantics (kept verbatim since those drive the app's own data
# model, not just review quality), but without the exhaustive example enumeration, the
# "understand existing code first" step (meaningless without Read/Grep/Glob), and the
# secondary "alternative approach" code block. Used for diff/curated mode.
REVIEW_PROMPT_LITE = """You are a Senior Software Engineer reviewing one file's changes from a production pull request. A unified diff for this file follows on stdin. Assume it is part of a production Laravel/PHP application unless the file's extension or content clearly indicates another stack.

Perform a risk-focused code review, not a style pass. Do not approve merely because the happy path works.

Check correctness in this priority order:

1. Functional/business-logic bugs
   - null, empty string, '0', 0, false, empty collection, and boundary-value handling
   - PHP truthy/falsy pitfalls, especially `if ($value)` when '', '0', 0, false, null, or [] are valid or meaningful values
   - unguarded null dereferences from `find()`, `first()`, `value()`, etc.
   - misuse of `optional()` that silently hides a required/missing value
   - swallowed exceptions or error states
   - incorrect state transitions, validation, branching, or business rules

2. Security
   - authentication/authorization failures
   - IDOR/BOLA
   - SQL, command, template, or other injection
   - mass assignment
   - XSS
   - secrets or PII exposure
   - unsafe file uploads
   - trusting client-side validation or other client-controlled security boundaries

3. Data loss/corruption
   - unscoped destructive queries
   - incorrect updates/deletes
   - missing transactions where an operation must be atomic
   - unhandled empty-result cases that can corrupt or incorrectly mutate state

4. Concurrency/state
   - race conditions
   - check-then-act bugs
   - missing locks where required
   - missing idempotency for operations that can be retried or repeated
   - duplicate processing or inconsistent state under concurrent requests/jobs

5. Performance/regressions
   - N+1 queries
   - unbounded or unexpectedly large queries
   - missing eager loading
   - unnecessary repeated database/API calls
   - materially expensive work introduced into hot paths
   - breaking an existing API/consumer contract when that contract can be established from the available code

6. Tests
   - missing tests for a meaningful new behavior or regression risk
   - incorrect tests that fail to cover the actual changed behavior
   - only flag tests when their absence is materially relevant; do not demand tests for trivial changes

7. Maintainability
   - only after higher-risk issues have been considered
   - unclear naming
   - over/under-engineering
   - unnecessary duplication
   - reinventing functionality already provided by an installed dependency or framework feature; when flagging this, name the relevant built-in/dependency feature

Validate before flagging:
- Check whether the behavior is already handled elsewhere in the shown code or is guaranteed by the framework/library.
- Do not infer unseen application behavior as fact.
- If a finding depends on an assumption that cannot be verified from the diff or available context, state the uncertainty explicitly.
- Never comment on code you have not actually read.
- Do not report pure style, formatting, subjective preferences, renames, or existing codebase conventions.
- Do not report the same root cause multiple times; prefer one precise finding.
- Recommend an architectural change only when the current responsibility is genuinely unclear or introduces real coupling. Do not recommend architectural changes reflexively.

If nothing is worth flagging, return an empty `comments` array.

Return ONLY valid JSON with this exact top-level shape:

{
  "comments": [
    {
      "file": "string",
      "line": 123,
      "side": "LEFT" | "RIGHT",
      "severity": "blocking" | "issue" | "suggestion" | "nit",
      "text": "string",
      "suggestion": "string" | null
    }
  ]
}

Finding rules:
- `file` must identify the reviewed file.
- `line` must be an actual line number present in the supplied diff.
- `side` must be `LEFT` for removed lines and `RIGHT` for added or context lines.
- Prefer `RIGHT` when the problem is introduced or observable on an added line. Use `LEFT` only when the finding specifically concerns removed behavior.
- Anchor each finding to the smallest relevant diff line that makes the problem understandable.
- `text` must be Markdown and contain:
  1. a bold headline naming the problem,
  2. brief prose explaining expected vs. actual behavior,
  3. a concrete failure scenario.
- Quote exact code in a fenced block only when it materially clarifies the finding.
- Keep each finding concise: a few sentences, not an essay.
- `suggestion` must contain the exact drop-in replacement code when a safe, local replacement exists. Match the original indentation. Do not include diff markers, Markdown fences, or explanation.
- Set `suggestion` to `null` for conceptual fixes, questions, larger refactors, or when an exact replacement cannot be determined safely.
- A `suggestion` is optional even for an actionable finding; never invent replacement code when the surrounding context is insufficient.

Severity:
- `blocking`: security vulnerability, data loss/corruption, or a production-breaking correctness issue that should block the PR.
- `issue`: a real bug, concurrency/state problem, or major correctness/performance regression that should be fixed, but is not necessarily an immediate production blocker.
- `suggestion`: a worthwhile non-bug improvement, including a dependency/framework capability that would materially simplify or improve the implementation.
- `nit`: a minor issue that should not block the PR.

Be conservative: report findings only when you can explain a concrete failure mode or a clearly justified improvement from the available code and context."""

# Fixed checklist shown in the client's "PR checklist" tab (see PLAN.md §10, condensed
# to the categories that are actually independently checkable — steps like "understand
# the PR first" are reasoning process, not a pass/warning verdict). ids are stable
# across reviews so the frontend can render a consistent list; label is shown alongside
# the status Claude assigns each one. Sourced from review_config.json's "checklist" —
# not hardcoded — so items can be added/removed/relabeled without a code change.
CHECKLIST_ITEMS = checklist_items()
CHECKLIST_ITEM_IDS = [item["id"] for item in CHECKLIST_ITEMS]

SUMMARY_PROMPT = f"""A unified diff for a full GitHub pull request follows on stdin. You are the same senior reviewer providing the overall orientation shown to a reviewer before they read the diff and before per-file inline findings.

Reason through the PR as a whole before writing the output. Your internal reasoning should cover:

- Intent and scope: What problem is this PR solving? Does the implementation actually solve that problem? Are there unrelated, unnecessary, or scope-creeping changes?
- Risk: Does it touch a high-risk area such as authentication/authorization, security-sensitive code, payments/financial operations, database migrations, data deletion/modification, concurrency/state, a public API, an external integration, or performance-critical code?
- Cross-file correctness: Read the diff as one change, not as isolated files. Check whether a changed interface, contract, schema, dependency, route, model, event, configuration value, or data shape affects another changed file. Look for backward-compatibility breaks and bugs that only appear from interaction between files.
- Tests: Are tests proportional to the risk and changed behavior? If existing behavior changes materially without corresponding test coverage, treat that as a review gap worth naming.
- Final gate: Does the implementation solve the intended problem? Are security, reliability, data-integrity, and compatibility risks addressed? Is the architecture appropriate? Are there remaining blocker- or major-level concerns?

Write `summary` as exactly:

"Verdict: <VERDICT> — <2-4 plain-English sentences>"

Where `<VERDICT>` is exactly one of:
- `APPROVE`
- `APPROVE WITH MINOR CHANGES`
- `CHANGES REQUESTED`
- `BLOCK`

Verdict guidance:
- `BLOCK`: a critical security vulnerability, likely data loss/corruption, or a production-breaking issue that makes merging unsafe.
- `CHANGES REQUESTED`: a real correctness, security, reliability, compatibility, concurrency, or major performance problem that should be fixed before merge.
- `APPROVE WITH MINOR CHANGES`: only non-blocking improvements remain, such as minor maintainability concerns, small test gaps, or worthwhile suggestions.
- `APPROVE`: no meaningful concerns remain after reviewing the diff as a whole.
- Do not choose a stronger verdict merely because the PR touches a high-risk area; judge the actual implementation and remaining risk.
- If there is a genuine blocker- or major-level concern, do not use either approval verdict.

The 2-4 sentences after the verdict must:
- explain what the PR actually changes and why it matters;
- describe the net effect across the files rather than recapping files or diff statistics;
- state whether the implementation stayed within scope, when that is meaningful;
- identify the single biggest risk area to pay attention to while reviewing, if one exists (for example, a migration, destructive query, external call, caching change, security boundary, or cross-file contract).

Do not repeat inline findings mechanically. The summary should orient the reviewer and identify the most important overall concern.

Also fill `checklist` with exactly one entry for every item below, preserving the exact id, order, group, and label. Do not add, skip, rename, or reorder items.

{chr(10).join(f'- "{item["id"]}" [{item["group"]}]: {item["label"]}' for item in CHECKLIST_ITEMS)}

For each checklist item:
- `status` must be exactly one of `pass`, `warning`, or `unchecked`.
- Use `pass` when the item meaningfully applies to this diff, was reviewed, and no real concern was found.
- Use `warning` when the item meaningfully applies to this diff and a genuine concern exists, at any severity.
- Use `unchecked` when the item does not meaningfully apply to the diff.
- For a [backend] item, use `unchecked` when the diff touches no backend/server-side files.
- For a [frontend] item, use `unchecked` when the diff touches no frontend/UI files.
- For a [common] item, use `unchecked` when it plainly does not apply to this diff, such as tests for a pure documentation/configuration change.
- Never guess or force a verdict for a stack that the diff does not touch.
- A checklist `warning` does not necessarily require an inline finding, but when an inline finding exists for the same category, the checklist warning should reflect the same underlying concern.

For each checklist item, set `note` to exactly one short, specific sentence grounded in the actual diff:
- Name the actual file, behavior, contract, query, component, test, or other concrete evidence whenever possible.
- Do not merely restate the checklist label.
- Avoid generic statements such as "security looks fine" or "tests are good."
- For `pass`, briefly state what was actually checked and why no concern was found.
- For `warning`, state the concrete concern and affected behavior.
- For `unchecked`, state either why the item does not apply or, when the reason is stack-specific, that the relevant stack is not present in the diff.
- Do not invent evidence that is not present in the supplied diff.

Return ONLY valid JSON. Do not include Markdown fences, commentary, or any text outside the JSON object.

Use exactly this top-level shape:

{{
  "summary": "Verdict: <VERDICT> — <2-4 sentences>",
  "checklist": [
    {{
      "id": "string",
      "status": "pass" | "warning" | "unchecked",
      "note": "string"
    }}
  ]
}}"""

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

Project convention — check this first:
- If the diff header shows this file is newly created (a "new file mode" line, or the old side is /dev/null), and it is a JavaScript source file (.js/.jsx, not .ts/.tsx), flag it as an "issue": new frontend application/source files must be written in TypeScript, not plain JavaScript.
- Do NOT apply that rule to renames/moves of existing files.
- Do NOT apply it to typical root-level tooling/configuration files that conventionally remain plain JavaScript even in TypeScript projects, such as vite.config.js, tailwind.config.js, postcss.config.js, or eslint configuration files.
- Use judgment to distinguish application/component source from tooling/configuration code. Do not flag a file merely because its extension is .js.

Keep the review process above, but for this file use the following correctness order instead of the general one above. Skip checks that plainly do not apply:

a. Functional/UI correctness
   - Does the UI behave according to the apparent requirement/design?
   - Are loading, empty, success, and error states handled where relevant?
   - What happens on a slow network, API failure, double-click, retry, or navigation away while an async operation is in flight?
   - Are disabled/loading controls actually protected against duplicate submissions?
   - Are success and failure states communicated clearly?
   - Do refresh, back, forward, retry, and repeated navigation behave correctly where relevant?
   - Check for incorrect event handling, stale UI state, missing cleanup, and incorrect conditional rendering.

b. State management
   - Is state kept at the appropriate level (local vs. shared/global)?
   - Are there duplicated sources of truth that can become inconsistent?
   - Could state updates race with asynchronous work?
   - Is derived state stored unnecessarily instead of being computed?
   - Could an effect trigger unnecessarily, repeatedly, or infinitely?
   - For React specifically, scrutinize useEffect dependency arrays, stale closures, callback dependencies, memoization, cleanup, and state updates from asynchronous callbacks.
   - Do not flag a dependency-array or memoization choice merely because it differs from a preferred style; identify the concrete stale-value, repeated-effect, render-loop, or performance consequence.

c. API/data handling
   - Is the API request/response contract used correctly?
   - Are loading and error states handled for new or changed calls?
   - Are requests duplicated or triggered unnecessarily?
   - Is caching appropriate for the actual data semantics?
   - What happens if the response is empty, missing an expected field, null, or otherwise differs from the assumed shape?
   - Check whether request cancellation/ignoring stale responses is needed when multiple requests can overlap.

d. Security
   - XSS or unsafe raw-HTML rendering
   - untrusted URLs used without appropriate validation
   - secrets, credentials, or sensitive tokens exposed to client code
   - sensitive tokens unnecessarily stored in localStorage/sessionStorage
   - insecure redirects or attacker-controlled navigation
   - user content rendered without appropriate escaping/sanitization
   - client-side authorization treated as a security boundary
   - Do not treat hiding a UI control as authorization; the backend must enforce access regardless of frontend behavior.

e. Accessibility
   - keyboard navigation and keyboard-operable interactions
   - focus management after dialogs, navigation, submission, validation, or dynamic content changes
   - semantic HTML
   - labels and accessible descriptions for form controls
   - accessible names for icon-only buttons and controls
   - appropriate ARIA usage
   - visible and programmatically determinable focus states
   - disabled/loading/error states communicated appropriately to assistive technology
   - features that only work with a mouse
   - Do not recommend ARIA when an appropriate native HTML element provides the required semantics.

f. Performance
   - unnecessary or repeated renders with a concrete cost
   - expensive work during render or on frequent interaction paths
   - unnecessary API requests
   - missing lazy-loading/code-splitting where the changed feature materially increases initial load
   - rendering very large lists without an appropriate strategy
   - blocking main-thread work
   - Do not recommend memo/useMemo/useCallback solely as a generic optimization. Flag them only when the diff provides evidence of an actual rendering or computation cost, or when their absence creates a concrete regression.

g. Responsive/cross-browser behavior
   - mobile, tablet, and desktop layouts where relevant
   - fixed widths or positioning that can cause overflow or clipping
   - long text and unusually large/small content
   - different font sizes or user zoom
   - localization/translation expansion where the feature participates in localized UI
   - browser-specific APIs or CSS behavior where compatibility is relevant
   - Do not speculate about a browser issue without a concrete compatibility concern visible from the changed code.

h. Tests
   - loading, empty, success, and error states where applicable
   - user interactions and important user-visible behavior
   - form validation and submission behavior
   - API failure/retry behavior
   - permission/role differences where relevant
   - race/duplicate-submit behavior when the implementation is vulnerable to it
   - Prefer tests of user-visible behavior over implementation details.
   - Only flag missing tests when the changed behavior or regression risk is meaningful; do not require tests for trivial presentation-only changes.

i. Maintainability
   - only after all higher-priority concerns above have been considered
   - unclear component responsibilities
   - unnecessary complexity or duplication
   - business logic unnecessarily coupled to presentation
   - opportunities to reuse an existing component, hook, utility, or UI-library capability
   - Before recommending a library capability, check the dependency list below for the exact library/version in use. Do not assume a capability exists or behaves the same across versions.
   - Prefer existing project patterns over introducing a new abstraction without evidence that it is needed.

Architecture:
- Is the component's responsibility clear, or is it doing too much at once (for example, API fetching, form state, business rules, and presentation)?
- Is business logic unnecessarily coupled to the UI?
- Are we duplicating an existing component, hook, utility, or shared abstraction?
- Are we duplicating a capability already provided by the UI library? Check the dependency list below for the exact library/version before making this claim.
- Would adding a similar new case (for example, another payment method or form-field type) require modifying this component in multiple places, when an existing extension point could avoid that coupling?
- Do not recommend architectural changes merely because another design is possible. Require evidence of unclear responsibility, meaningful coupling, duplication, or a concrete maintenance problem.

Visual/design changes:
- If this diff makes a visual/UI change and a linked design/spec is available, compare the implementation against that design/spec when the relevant details can actually be determined.
- Check spacing, typography, colors, sizing, layout, and hover/focus/disabled/loading/error states where applicable.
- Consider whether the change unintentionally affects existing screens or shared components.
- If visual-regression snapshots are present or clearly used by the project, note when the changed behavior would require updating them.
- Do not claim a visual mismatch when no design/spec or sufficient visual evidence is available.
- Do not flag subjective aesthetic differences as correctness issues unless they clearly contradict an available design/spec or established project requirement.

Evidence standard:
- Only flag issues supported by the supplied diff, linked design/spec, dependency information, or other explicitly available context.
- Do not invent product requirements, browser behavior, component APIs, library capabilities, or project conventions.
- If a concern depends on an assumption that cannot be verified, state the uncertainty rather than presenting it as fact.
"""


BACKEND_NEW_FILE_ADDENDUM = """

This file is backend/server-side code.

Project convention — check this first:
- Determine whether the file is genuinely new: the diff header shows a "new file mode" line or the old side is /dev/null.
- Do NOT treat a rename/move of an existing file as new.
- Do NOT apply this addendum to config, migration, DTO, value-object, schema, enum, or plain-data files when they contain no meaningful behavior.
- If the file existed before this PR, skip this entire addendum.

For a genuinely new behavioral backend file, perform one additional low-level design (LLD) review focused on object-design pattern fit. This is specifically about GoF-style/object-level design patterns, not high-level system architecture. Relevant patterns may include Repository, Factory/Abstract Factory, Builder, Strategy, Observer, Decorator, Adapter, Command, Template Method, Facade, Singleton, and similar patterns.

Before commenting:
- Identify the actual responsibilities and collaboration points in the file.
- Name any recognizable pattern actually used by the implementation, rather than inferring a pattern merely because the class has a familiar name.
- Consider how the file is likely to evolve based on the behavior visible in the diff.
- Do not recommend a pattern merely because it is available or theoretically applicable.
- Prefer the simplest design that fits the current responsibility.
- Do not introduce pattern terminology when ordinary composition or a straightforward class/function is already the appropriate design.

If the file has a meaningful LLD/design issue:
- Add exactly one additional comment focused on that issue.
- Explain which pattern is currently being used (if any), whether it fits the responsibility, and the concrete consequence of the current design.
- If a different or additional pattern would genuinely improve the design, name it specifically and explain why.
- Make the recommendation concrete. For example:
  "This class both queries the database and enforces business rules. Extracting the persistence behavior behind a Repository would isolate the database dependency, making the rule logic independently testable and allowing the persistence implementation to change without modifying the business rules."
- Avoid vague comments such as "consider separation of concerns" or "use a design pattern here."

If the existing design is a good fit:
- Do NOT invent a problem merely to satisfy this addendum.
- If the review system requires a confirming architecture note for every new behavioral file, explicitly state which pattern/responsibility fits and why it is appropriate. Otherwise, omit the additional comment when there is no actionable concern.

Severity:
- Use "suggestion" for a worthwhile but non-blocking LLD improvement or confirming design note.
- Use "issue" only when the current design already creates a concrete problem evident from the diff, such as tightly coupled responsibilities that materially hinder testing, a clearly duplicated construction strategy, or an extension point that will predictably require invasive changes.
- Never use "blocking" or "nit" for this LLD addendum.

Do not recommend high-level architectural changes such as introducing new services, event-driven architecture, repositories across the entire application, microservices, or changing system boundaries merely because they are theoretically possible. Keep the review scoped to the object-level design of this specific file.

Base the assessment only on the supplied diff and explicitly available project context. Do not assume unseen callers, future requirements, or application conventions. If the pattern fit depends on an unverified assumption, state that uncertainty rather than asserting it as fact.
"""


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


# Backs use_system_prompt in _run_claude_call below. Content-addressed rather than a
# fresh tempfile.mkstemp() per call: since REVIEW_PROMPT/addenda only ever take a couple
# of fixed values (frontend/backend), every review of that variant — any repo, any PR —
# resolves to the exact same path and file, which is what makes the CLI's prompt cache
# actually treat repeat calls as identical. Written once (first call to see a given
# variant this process); never rewritten after that, since the content is a pure
# function of this module's own constants and can't change without a code edit (which
# already requires a server restart — see CLAUDE.md's "no --reload" note). The rename is
# atomic so a concurrent writer for the same variant can never leave a reader with a
# partial file.
_SYSTEM_PROMPT_CACHE_DIR = Path(tempfile.gettempdir()) / "pr-review-studio-system-prompts"


def _system_prompt_file_for(prompt: str) -> str:
    _SYSTEM_PROMPT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
    path = _SYSTEM_PROMPT_CACHE_DIR / f"{digest}.txt"
    if not path.exists():
        tmp_path = path.with_suffix(f".{os.getpid()}.tmp")
        tmp_path.write_text(prompt, encoding="utf-8")
        os.replace(tmp_path, path)
    return str(path)


# Runs one headless `claude -p` call over `stdin_text`, validated against `schema`.
# Shared by both the per-file comment calls and the whole-diff summary call.
async def _run_claude_call(
    prompt: str,
    stdin_text: str,
    schema: dict[str, Any],
    cwd: str | None = None,
    tools: str | None = None,
    use_system_prompt: bool = False,
    context_text: str = "",
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

    # use_system_prompt=True moves `prompt` (REVIEW_PROMPT/SUMMARY_PROMPT + addenda — the
    # same fixed text on every call with no cwd) into --system-prompt-file instead of the
    # stdin blob. Two wins verified empirically: it replaces the CLI's own default system
    # prompt (which auto-discovers this app's own CLAUDE.md and other per-machine context
    # totally irrelevant to reviewing someone else's diff — ~8-9K tokens of pure overhead
    # per call in testing), and it gives Anthropic's prompt cache a clean, stable boundary
    # to reuse across every file/review instead of a blob whose tail (the diff) always
    # differs — a repeat call with an unchanged --system-prompt-file dropped from ~$0.036
    # (cache miss) to ~$0.003 (full cache hit). Not used for deep-mode calls: those already
    # have a per-repo/per-PR cwd making each one unique, so there's little cross-call
    # caching to gain, and the CLI's own environment/tooling context is more plausibly
    # relevant when tools are enabled.
    #
    # context_text is kept separate from `prompt` on purpose: it's per-review/per-repo
    # material (dependency manifests, linked-PR diffs, curated call-site snippets) that's
    # never the same across two different PRs, so it always travels with the diff on
    # stdin — folding it into `prompt` would make every review's --system-prompt-file
    # unique and defeat the whole point of caching it (REVIEW_PROMPT + addenda alone has
    # only a couple of fixed variants total, shared across every repo and every review).
    diff_block = f"--- BEGIN DIFF ---\n{stdin_text}\n--- END DIFF ---"
    body = f"{context_text}\n\n{diff_block}" if context_text else diff_block

    if use_system_prompt:
        # Verified empirically that the cache boundary keys off the --system-prompt-file
        # *path*, not just its contents — a fresh tempfile.mkstemp() path per call missed
        # cache every time even with byte-identical content, while reusing the same path
        # hit full cache. So this resolves to a stable, content-addressed path instead of a
        # per-call temp file: identical prompt text (there are only a couple of variants —
        # frontend/backend addenda — ever produced here) always maps to the same file, so
        # every review across every repo shares one cached system prompt per variant.
        args += ["--system-prompt-file", _system_prompt_file_for(prompt)]
        stdin_payload = body
    else:
        stdin_payload = f"{prompt}\n\n{body}"

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
    repo_name: str,
    dep_context: str | None,
    phpstan_context: str | None,
    linked_context: str | None,
    curated_context: str | None,
) -> tuple[list[dict[str, Any]], dict[str, float | int]]:
    is_frontend = _classify_frontend(chunk["path"], repo_name)
    frontend_addendum = FRONTEND_REVIEW_ADDENDUM if is_frontend else ""
    # LLD/design-pattern check only makes sense for backend files that actually have
    # behavior to structure — frontend gets its own architecture guidance above instead.
    backend_addendum = BACKEND_NEW_FILE_ADDENDUM if not is_frontend else ""
    tools_addendum = CODEBASE_CONTEXT_ADDENDUM if cwd else ""
    # Full instructions only in deep mode — everywhere else uses the condensed
    # REVIEW_PROMPT_LITE, since caching doesn't reduce this cost (see _run_claude_call)
    # and shorter text is what actually cuts tokens for diff/curated mode.
    review_prompt = REVIEW_PROMPT_FULL if cwd else REVIEW_PROMPT_LITE

    # dep_context/phpstan_context come from the PR's actual head commit via the GitHub
    # Contents API (see routes/reviews.py) — available in every mode, not just deep — so a
    # Read/Grep/Glob-less diff/curated review still knows what's already installed before
    # suggesting new code that reinvents it. Only the manifest relevant to this file's own
    # stack is included — a backend file gets no benefit from the Node dependency list, a
    # frontend file none from PHPStan's config.
    manifest_addendum = (dep_context or "") if is_frontend else (phpstan_context or "")
    linked_curated_addendum = f"{_linked_pr_addendum(linked_context)}{_curated_context_addendum(curated_context)}"

    if cwd:
        # Deep mode never uses --system-prompt-file (see _run_claude_call's
        # use_system_prompt), so there's no cached file to keep lean — everything goes
        # into one blob sent inline on stdin, as before.
        static_prompt = f"{review_prompt}{frontend_addendum}{backend_addendum}{tools_addendum}"
        context_text = f"{manifest_addendum}{linked_curated_addendum}"
    else:
        # diff/curated mode: static_prompt IS the --system-prompt-file, so it stays just
        # REVIEW_PROMPT_LITE — completely identical for every file, frontend or backend —
        # instead of splitting into an is_frontend-dependent variant. That's the difference
        # between two cached files (one per stack) and a single one shared by every file,
        # every repo, every review. frontend_addendum/backend_addendum are exactly as
        # PR/file-specific as manifest_addendum, so they move to context_text (stdin,
        # alongside the diff) for the same reason that one's already there.
        static_prompt = review_prompt
        context_text = f"{frontend_addendum}{backend_addendum}{manifest_addendum}{linked_curated_addendum}"

    parsed, usage = await _run_claude_call(
        static_prompt,
        chunk["text"],
        COMMENTS_SCHEMA,
        cwd=cwd,
        tools="Read,Grep,Glob" if cwd else None,
        use_system_prompt=not cwd,
        context_text=context_text,
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
    repo_name: str = "",
    linked_context: str | None = None,
    curated_context: str | None = None,
    dep_context: str | None = None,
    phpstan_context: str | None = None,
) -> dict[str, Any]:
    chunks = [c for c in split_diff_by_file(diff) if not _is_trivial_chunk(c["path"], c["text"])]

    # The summary/checklist needs its own whole-diff call — only run it in deep mode.
    # diff/curated reviews (the common case, including batch review) skip it entirely:
    # no verdict line, no PR-checklist tab for those, but one fewer full-prompt Claude
    # call on every review that isn't deep.
    summary_task = (
        asyncio.ensure_future(_run_summary(diff, linked_context, curated_context)) if mode == "deep" else None
    )

    per_file_comments: list[list[dict[str, Any]] | None] = [None] * len(chunks)
    per_file_usage: list[dict[str, float | int] | None] = [None] * len(chunks)
    indexed_chunks = list(enumerate(chunks))

    async def review_one(item: tuple[int, dict[str, Any]], _local_i: int) -> None:
        i, chunk = item
        comments, usage = await _run_file_review(
            chunk, cwd, repo_name, dep_context, phpstan_context, linked_context, curated_context
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

    if summary_task is not None:
        summary, checklist, summary_usage = await summary_task
    else:
        summary, checklist, summary_usage = "", [], ZERO_USAGE
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
