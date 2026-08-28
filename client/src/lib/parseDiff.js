const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseUnifiedDiff(diffText) {
  const lines = diffText.split("\n");
  const files = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i++;
      continue;
    }

    const file = { path: null, oldPath: null, binary: false, additions: 0, deletions: 0, hunks: [] };
    i++;

    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
      const line = lines[i];
      if (line.startsWith("--- ")) {
        const p = line.slice(4).trim();
        file.oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
      } else if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        file.path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      } else if (line.startsWith("Binary files ")) {
        file.binary = true;
      } else if (line.startsWith("rename to ")) {
        file.path = line.slice("rename to ".length).trim();
      } else if (line.startsWith("rename from ")) {
        file.oldPath = line.slice("rename from ".length).trim();
      }
      i++;
    }
    if (!file.path) file.path = file.oldPath;

    while (i < lines.length && lines[i].startsWith("@@")) {
      const match = lines[i].match(HUNK_HEADER);
      let oldLine = 1;
      let newLine = 1;
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      const hunk = {
        header: lines[i],
        heading: match?.[3]?.trim() ?? "",
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      i++;

      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
        const line = lines[i];
        if (line.startsWith("\\ No newline")) {
          i++;
          continue;
        }
        if (line.startsWith("+")) {
          hunk.lines.push({ type: "add", content: line.slice(1), oldLine: null, newLine });
          newLine++;
          file.additions++;
        } else if (line.startsWith("-")) {
          hunk.lines.push({ type: "del", content: line.slice(1), oldLine, newLine: null });
          oldLine++;
          file.deletions++;
        } else if (line.startsWith(" ")) {
          hunk.lines.push({ type: "context", content: line.slice(1), oldLine, newLine });
          oldLine++;
          newLine++;
        } else {
          break;
        }
        i++;
      }
      // oldLine/newLine sit one past the last line consumed, so end = that - 1.
      hunk.oldEnd = oldLine - 1;
      hunk.newEnd = newLine - 1;
      file.hunks.push(hunk);
    }

    files.push(file);
  }

  return files;
}

// Split (side-by-side) view needs each hunk's flat add/del/context sequence regrouped
// into paired rows: a run of consecutive deletions lines up against the run of
// consecutive additions that follows it (GitHub's own pairing heuristic), padding the
// shorter run with blanks. Context lines just occupy both sides of their own row.
export function toSplitRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels = [];
    while (i < lines.length && lines[i].type === "del") {
      dels.push(lines[i]);
      i++;
    }
    const adds = [];
    while (i < lines.length && lines[i].type === "add") {
      adds.push(lines[i]);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let j = 0; j < max; j++) {
      rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return rows;
}

// Sanitized so it's safe to use as both an HTML id and a scroll-target anchor.
export function fileElementId(path) {
  return `file-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

// Turns the flat file list into a GitHub-style folder tree: folders sorted before
// files, both alphabetically, so a repo with nested paths renders as collapsible
// directories instead of one long flat list of full paths.
export function buildFileTree(files) {
  const root = { type: "folder", name: "", path: "", children: new Map() };

  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(name)) {
        node.children.set(name, { type: "folder", name, path, children: new Map() });
      }
      node = node.children.get(name);
    }
    const name = parts[parts.length - 1];
    node.children.set(name, {
      type: "file",
      name,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    });
  }

  function toSorted(node) {
    const children = [...node.children.values()]
      .map((child) => (child.type === "folder" ? { ...child, children: toSorted(child) } : child))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return children;
  }

  return toSorted(root);
}

// Describes the hidden, unmodified regions of the file that the diff omits: before
// the first hunk, between two hunks, and after the last hunk (bounded only once the
// full file is fetched, since the diff itself doesn't say how long the file is).
// `offset` (newLine - oldLine, constant across an unmodified region) lets the caller
// compute old-file line numbers for any revealed line without re-parsing anything.
export function computeGaps(file) {
  const hunks = file.hunks;
  if (hunks.length === 0) return [];
  const gaps = [];

  if (hunks[0].newStart > 1) {
    gaps.push({
      id: `${file.path}::lead`,
      kind: "lead",
      newStart: 1,
      newEnd: hunks[0].newStart - 1,
      offset: hunks[0].newStart - hunks[0].oldStart,
      afterHunkIndex: -1,
    });
  }

  for (let i = 0; i < hunks.length - 1; i++) {
    const a = hunks[i];
    const b = hunks[i + 1];
    if (b.newStart - 1 >= a.newEnd + 1) {
      gaps.push({
        id: `${file.path}::mid${i}`,
        kind: "mid",
        newStart: a.newEnd + 1,
        newEnd: b.newStart - 1,
        offset: b.newStart - b.oldStart,
        afterHunkIndex: i,
      });
    }
  }

  const last = hunks[hunks.length - 1];
  gaps.push({
    id: `${file.path}::trail`,
    kind: "trail",
    newStart: last.newEnd + 1,
    newEnd: null,
    offset: last.newEnd - last.oldEnd,
    afterHunkIndex: hunks.length - 1,
  });

  return gaps;
}

function lineKeys(filePath, line) {
  const keys = [];
  if (line.newLine != null) keys.push(`${filePath}::RIGHT::${line.newLine}`);
  if (line.oldLine != null) keys.push(`${filePath}::LEFT::${line.oldLine}`);
  return keys;
}

// Attaches each review comment to the diff line it targets (by file/side/line number),
// so the caller can render it inline instead of as a flat list. Comments whose
// file/line don't correspond to any rendered diff line (a stale review, a model
// off-by-one) fall into `unmatched` rather than silently vanishing.
export function matchCommentsToDiff(files, comments) {
  const validKeys = new Set();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        for (const key of lineKeys(file.path, line)) validKeys.add(key);
      }
    }
  }

  const byKey = new Map();
  const unmatched = [];
  const countsByFile = new Map();
  for (const comment of comments) {
    const key = `${comment.file}::${comment.side}::${comment.line}`;
    if (!validKeys.has(key)) {
      unmatched.push(comment);
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(comment);
    countsByFile.set(comment.file, (countsByFile.get(comment.file) ?? 0) + 1);
  }

  return {
    commentsForLine: (filePath, line) =>
      lineKeys(filePath, line).flatMap((key) => byKey.get(key) ?? []),
    commentCountForFile: (filePath) => countsByFile.get(filePath) ?? 0,
    unmatched,
  };
}
