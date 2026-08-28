import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { mapWithConcurrency } from "./concurrency.js";

const REVIEW_CONCURRENCY = 4;

// Files where a per-line review is never useful — skipping them means fewer, faster
// claude calls with no loss in review quality. Path check is deliberately loose (matches
// anywhere in the path) since these show up nested under workspace subfolders too.
const TRIVIAL_PATH_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock)$/;
const GENERATED_PATH_RE = /(^|\/)(dist|build|vendor|node_modules)\//;
const MINIFIED_OR_MAP_RE = /\.(min\.js|min\.css|map)$/;

function isTrivialChunk(filePath, chunkText) {
  if (chunkText.includes("\nBinary files ")) return true;
  if (!filePath) return false;
  return TRIVIAL_PATH_RE.test(filePath) || GENERATED_PATH_RE.test(filePath) || MINIFIED_OR_MAP_RE.test(filePath);
}

// Splits a unified diff into one chunk per file (each starting at its "diff --git "
// line), so files can be reviewed independently and in parallel instead of one big
// sequential pass over the whole diff.
export function splitDiffByFile(diffText) {
  const lines = diffText.split("\n");
  const chunks = [];
  let current = null;

  function pushCurrent() {
    if (current) chunks.push({ path: current.path, text: current.lines.join("\n") });
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      current = { path: null, lines: [line] };
      continue;
    }
    if (!current) continue; // preamble before the first "diff --git ", if any
    current.lines.push(line);
    if (current.path == null) {
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        current.path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      } else if (line.startsWith("rename to ")) {
        current.path = line.slice("rename to ".length).trim();
      }
    }
  }
  pushCurrent();

  // A pure delete has no "+++ b/..." line to read the path from — fall back to "--- a/...".
  for (const chunk of chunks) {
    if (chunk.path == null) {
      const oldLine = chunk.text.split("\n").find((l) => l.startsWith("--- "));
      if (oldLine) {
        const p = oldLine.slice(4).trim();
        chunk.path = p === "/dev/null" ? null : p.replace(/^a\//, "");
      }
    }
  }

  return chunks;
}

const REVIEW_PROMPT = `You are a Senior Software Engineer, Technical Lead, and Code Reviewer reviewing one file's changes from a larger production pull request. A unified diff for this single file follows on stdin. Assume it's part of a production Laravel/PHP application unless the file's extension or content clearly indicates another stack — apply the equivalent scrutiny either way.

Perform a deep, practical, risk-focused review — not a syntax or style pass. Do not approve just because the happy path works. Review simultaneously from the perspective of: Senior Engineer, Team Lead, Solution Architect, Security Reviewer, Performance Engineer, Database Reviewer, QA/Test Engineer, and Production/DevOps Engineer. For every finding, think about what happens when things go wrong, not only when everything goes right.

Actively check for (in rough priority order — earlier items matter more):
1. Business-logic correctness: does this code actually do what it appears intended to do? Could it produce a valid technical result but a wrong business result? Are edge cases, duplicate/missing records, and invalid values handled?
2. Correctness across inputs: null, empty string, '0', 0, false, empty array/collection, missing keys, unexpected types, boundary/very large values, malformed/invalid dates. In PHP specifically, scrutinize truthy/falsy checks like \`if ($value)\` against '', '0', 0, 0.0, false, null, [] — is the behavior actually intentional?
3. Null safety: every place a value can be null (\`find()\`, \`first()\`, \`value()\`, \`optional()\`, \`?->\`, \`??\`) — does the code's handling match actual runtime nullability? Don't suggest removing a null check just because static analysis claims non-null; if static analysis looks wrong, say so and suggest fixing the type info instead.
4. Error/exception handling: caught at the right layer, not swallowed (e.g. \`catch (\\Throwable) { return []; }\` hiding a real failure), sensitive details kept out of logs, caller can distinguish expected failure from system failure.
5. Security: authn/authz on the operation, IDOR/BOLA (can changing an ID expose another user's data), SQL injection / unsafe raw queries, mass assignment, XSS, secrets/PII in code or logs, unsafe file uploads. Never treat client-side validation as a security boundary.
6. Database correctness and safety: correct joins/filters/aggregation, what happens on zero rows returned (\`find()\`/\`value()\` → null, \`get()\`/\`pluck()\` → empty collection), destructive UPDATE/DELETE without a narrow enough WHERE, missing transactions where multiple writes must be atomic, race conditions like check-then-create without a unique constraint.
7. Query efficiency and N+1: queries inside loops, \`get()\` then filtering/counting in PHP where \`exists()\`/\`count()\`/\`value()\`/\`pluck()\` would do it in the database, missing eager loading, unbounded/unpaginated queries.
8. Concurrency/idempotency: what happens if two requests run this simultaneously, or if a job/webhook/payment operation runs twice — are unique constraints, locks, or idempotency keys needed?
9. API compatibility: could this response-shape/status-code/validation change break an existing consumer?
10. Caching: cache key uniqueness, TTL, and — critically — is there any invalidation path when the underlying data changes?
11. Only after all the above: maintainability, naming, magic numbers/strings worth naming, unnecessary complexity, over-engineering (abstraction with no real problem it solves) and under-engineering (huge unstructured methods, duplicated business logic).

Do NOT flag: pure style/formatting preferences, renames, or anything the codebase's existing conventions already do consistently elsewhere — automated tools handle those. Do not comment on code you have not actually read on both sides of the change (don't guess). Skip trivial or already-correct code. Never invent a duplicate of a comment you already made elsewhere. If there's nothing worth flagging, return an empty "comments" array — an empty result is a valid, good outcome.

For each finding, add an entry to "comments" — file, line (as shown in the diff hunk), side ("LEFT" for a removed/original line, "RIGHT" for an added or context line), and a specific, actionable comment that names the concrete failure mode and, where it isn't obvious, why it matters (e.g. "what happens when zero records are returned" or "what happens if this runs twice"). Set "severity": "blocking" only for things that would break production, corrupt/lose data, or are a security risk; "issue" for a real bug or major correctness/performance/data-integrity problem that should be fixed before merge; "suggestion" for a worthwhile improvement that isn't a bug; "nit" for a minor/maintainability point. Mention a concrete strength only when genuinely notable (e.g. "good use of a DB transaction here") — never generic praise, and never as its own comment separate from an actual finding.

When you have a concrete code fix in mind, also set "suggestion" to the exact replacement text for that line (or lines) — matching the original indentation, no diff markers (+/-), no explanation, just the code that should replace what's there, ready to drop in as-is. Set "suggestion" to null when the comment is conceptual (a question, a design concern, something needing a bigger rework, a missing test, or a migration/deployment/rollback risk) rather than a specific line-level edit.`;

const SUMMARY_PROMPT = `A unified diff for a full GitHub pull request follows on stdin. You are the same senior reviewer providing the overall orientation shown to a reviewer before they read the diff (and before per-file inline findings). Write "summary" as:

1. One verdict line, exactly one of: "APPROVE", "APPROVE WITH MINOR CHANGES", "CHANGES REQUESTED", or "BLOCK" — based on the overall risk (production breakage, data loss, security, incorrect business logic, or major performance problems push toward CHANGES REQUESTED/BLOCK; only cosmetic/minor concerns still allow APPROVE WITH MINOR CHANGES).
2. Then 2-4 plain-English sentences: what this PR actually changes and why it matters (the net effect across all files, not a line-by-line recap or diff-stat restatement), plus a one-line note on the single biggest risk area to pay attention to while reviewing (if any) — e.g. a migration, a destructive query, a new external call, a caching change.

Format as: "Verdict: <VERDICT> — <sentences>".`;

const CODEBASE_CONTEXT_ADDENDUM = `

The full repository (at the PR's head commit) is checked out at your current working directory — you have Read, Grep, and Glob available to consult it. Use them where they'd change your review: how a changed function/export is called elsewhere, whether a change matches existing conventions in the same file or module, related types/config the diff doesn't show. Stay targeted — look at this file and things it directly references/imports; do not do an open-ended crawl of the repository.`;

function readDependencyContext(cwd) {
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const entries = Object.entries(deps);
    if (entries.length === 0) return null;
    const list = entries.map(([name, version]) => `${name}@${version}`).join(", ");
    return `\n\nProject dependencies (from package.json — reason about these exact versions, not generic advice):\n${list}`;
  } catch {
    return null;
  }
}

// PHPStan's config declares the project's enforced static-analysis level and any
// paths/rules it deliberately ignores — reviewing PHP without it risks flagging things
// the project has already decided not to enforce, or missing its configured level.
function readPhpStanContext(cwd) {
  try {
    const configPath = ["phpstan.neon", "phpstan.neon.dist"]
      .map((name) => path.join(cwd, name))
      .find((p) => fs.existsSync(p));
    if (!configPath) return null;
    const contents = fs.readFileSync(configPath, "utf-8").trim();
    if (!contents) return null;
    return `\n\nPHPStan config (${path.basename(configPath)} — this project's enforced static-analysis level and any ignored paths/rules; align PHP review comments with it rather than a generic/stricter standard):\n${contents}`;
  } catch {
    return null;
  }
}

const COMMENTS_SCHEMA = {
  type: "object",
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          side: { type: "string", enum: ["LEFT", "RIGHT"] },
          text: { type: "string" },
          severity: { type: "string", enum: ["nit", "suggestion", "issue", "blocking"] },
          suggestion: { type: ["string", "null"] },
        },
        required: ["file", "line", "side", "text", "severity", "suggestion"],
      },
    },
  },
  required: ["comments"],
};

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};

// Runs one headless `claude -p` call over `stdinText`, validated against `schema`.
// Shared by both the per-file comment calls and the whole-diff summary call.
function runClaudeCall(prompt, stdinText, schema, { cwd, tools } = {}) {
  return new Promise((resolve, reject) => {
    // shell:false + relying on PATH resolution of claude.exe directly (a real native
    // binary, not a .cmd shim) is deliberate: routing this through cmd.exe (shell:true)
    // re-quotes the --json-schema argument and silently corrupts it on Windows.
    const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema)];
    if (tools) {
      // Enabling any tools requires bypassPermissions here — verified empirically that
      // a piped -p session with tools enabled but no permission-mode hangs forever with
      // no output, presumably waiting on a prompt that can never arrive over stdin. Safe
      // because the tool set is still restricted to read-only Read/Grep/Glob.
      args.push("--tools", tools, "--permission-mode", "bypassPermissions");
    } else {
      args.push("--tools", "");
    }

    const child = spawn("claude", args, { cwd, shell: false });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => reject(new Error(`Failed to launch claude CLI: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr || "no stderr output"}`));
        return;
      }
      try {
        resolve(parseEnvelope(stdout));
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.write(`${prompt}\n\n--- BEGIN DIFF ---\n${stdinText}\n--- END DIFF ---`);
    child.stdin.end();
  });
}

async function runFileReview(chunk, { cwd, depContext, phpStanContext }) {
  const prompt = cwd
    ? `${REVIEW_PROMPT}${CODEBASE_CONTEXT_ADDENDUM}${depContext ?? ""}${phpStanContext ?? ""}`
    : REVIEW_PROMPT;
  const envelope = await runClaudeCall(prompt, chunk.text, COMMENTS_SCHEMA, {
    cwd,
    tools: cwd ? "Read,Grep,Glob" : null,
  });
  return envelope.comments;
}

async function runSummary(diffText) {
  const envelope = await runClaudeCall(SUMMARY_PROMPT, diffText, SUMMARY_SCHEMA);
  return envelope.summary;
}

// Reviews a whole PR diff by splitting it per file and reviewing files in parallel
// (bounded concurrency) instead of one long sequential call over the entire diff —
// the dominant cost for multi-file PRs, and especially for deep review where each
// file's Read/Grep/Glob turns used to run one after another. The summary is generated
// by its own lightweight call, run concurrently with the per-file passes.
export async function runReview(diff, { cwd } = {}) {
  const depContext = cwd ? readDependencyContext(cwd) : null;
  const phpStanContext = cwd ? readPhpStanContext(cwd) : null;
  const chunks = splitDiffByFile(diff).filter((c) => !isTrivialChunk(c.path, c.text));

  const summaryPromise = runSummary(diff);

  const perFileComments = new Array(chunks.length).fill(null);
  await mapWithConcurrency(chunks, REVIEW_CONCURRENCY, async (chunk, i) => {
    perFileComments[i] = await runFileReview(chunk, { cwd, depContext, phpStanContext });
  });

  const [summary] = await Promise.all([summaryPromise]);
  return { summary, comments: perFileComments.flat() };
}

const VALID_SEVERITIES = new Set(["nit", "suggestion", "issue", "blocking"]);

function parseEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI did not return a valid JSON envelope: ${stdout.slice(0, 500)}`);
  }
  if (envelope.is_error) {
    throw new Error(`claude CLI reported an error: ${envelope.result ?? stdout.slice(0, 500)}`);
  }

  const structured = envelope.structured_output ?? {};
  const result = {};
  if (Array.isArray(structured.comments)) {
    result.comments = structured.comments
      .filter((c) => c && typeof c.file === "string" && typeof c.text === "string")
      .map((c) => ({
        file: c.file,
        line: Number.isFinite(c.line) ? c.line : null,
        side: c.side === "LEFT" ? "LEFT" : "RIGHT",
        text: c.text,
        severity: VALID_SEVERITIES.has(c.severity) ? c.severity : "suggestion",
        suggestion: typeof c.suggestion === "string" && c.suggestion.trim() !== "" ? c.suggestion : null,
      }));
  }
  if (typeof structured.summary === "string") {
    result.summary = structured.summary.trim();
  }

  if (result.comments === undefined && result.summary === undefined) {
    throw new Error(
      `claude CLI response had no structured "comments" or "summary": ${stdout.slice(0, 500)}`
    );
  }

  return result;
}
