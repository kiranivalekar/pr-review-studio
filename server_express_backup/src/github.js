const API_BASE = "https://api.github.com";

function token() {
  const t = process.env.GITHUB_TOKEN;
  if (!t) {
    throw Object.assign(new Error("GITHUB_TOKEN is not set"), { status: 500 });
  }
  return t;
}

async function ghFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(
      new Error(`GitHub API ${path} failed: ${res.status} ${body}`),
      { status: res.status === 404 ? 404 : 502 }
    );
  }
  return res.json();
}

export async function getAuthenticatedLogin() {
  const user = await ghFetch("/user");
  return user.login;
}

// review-requested (not assignee) is what actually means "this PR needs my review" —
// GitHub's Assignees field is a separate, often-unused concept for who's doing the work.
export async function searchReviewRequestedOpenPRs(login) {
  const q = encodeURIComponent(`is:pr is:open review-requested:${login}`);
  const result = await ghFetch(`/search/issues?q=${q}&per_page=50`);
  return result.items;
}

export function parsePRUrl(url) {
  const match = String(url)
    .trim()
    .match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw Object.assign(new Error("Not a GitHub PR URL"), { status: 400 });
  }
  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number) };
}

export async function getPR(owner, repo, number) {
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}`);
}

export async function getPRDiff(owner, repo, number) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/pulls/${number}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github.v3.diff",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(
      new Error(`GitHub diff fetch for ${owner}/${repo}#${number} failed: ${res.status} ${body}`),
      { status: res.status === 404 ? 404 : 502 }
    );
  }
  return res.text();
}

// Used for hunk-expansion (GitHub-style "show more lines"): the diff only carries
// hunk context, so revealing the lines between/around hunks needs the actual file.
export async function getFileContent(owner, repo, path, ref) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const result = await ghFetch(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(result) || result.type !== "file" || typeof result.content !== "string") {
    throw Object.assign(new Error(`${path} at ${ref} is not a plain file`), { status: 422 });
  }
  return Buffer.from(result.content, "base64").toString("utf-8");
}

export function normalizePR(pr, { owner, repo, source }) {
  return {
    repo: `${owner}/${repo}`,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login,
    updatedAt: pr.updated_at,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    source,
    state: pr.merged_at ? "merged" : pr.state, // "open" | "closed" | "merged"
  };
}

// Uses the modern line+side form (no manual diff-relative `position` math needed —
// GitHub resolves line+side+commit_id against the diff itself).
export async function createPullRequestReview(owner, repo, number, { commitId, body, event = "COMMENT", comments }) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commit_id: commitId, body, event, comments }),
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw Object.assign(
      new Error(`GitHub review post to ${owner}/${repo}#${number} failed: ${res.status} ${responseBody}`),
      { status: res.status === 404 ? 404 : 502 }
    );
  }
  return res.json();
}

export function repoOwnerFromUrl(repositoryUrl) {
  // repository_url looks like https://api.github.com/repos/owner/repo
  const match = repositoryUrl.match(/repos\/([^/]+)\/([^/]+)$/);
  if (!match) return { owner: null, repo: null };
  return { owner: match[1], repo: match[2] };
}
