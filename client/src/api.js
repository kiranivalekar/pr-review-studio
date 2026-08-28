async function request(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export function fetchPRs() {
  return request("/prs");
}

export function addPR(url) {
  return request("/added-prs", { method: "POST", body: JSON.stringify({ url }) });
}

export function removePR(repo, number) {
  const [owner, name] = repo.split("/");
  return request(`/added-prs/${owner}/${name}/${number}`, { method: "DELETE" });
}

export async function fetchPRDiff(owner, repo, number) {
  const res = await fetch(`/api/prs/${owner}/${repo}/${number}/diff`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.text();
}

export async function fetchFileContent(owner, repo, number, path) {
  const res = await fetch(`/api/prs/${owner}/${repo}/${number}/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.text();
}

export function runReview(repo, number, mode = "diff") {
  return request("/review", { method: "POST", body: JSON.stringify({ repo, number, mode }) });
}

export function batchReviewRepo(repo, numbers) {
  return request("/reviews/batch", { method: "POST", body: JSON.stringify({ repo, numbers }) });
}

export function fetchReviews({ repo, number, state } = {}) {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  if (number !== undefined) params.set("number", number);
  if (state) params.set("state", state);
  const qs = params.toString();
  return request(`/reviews${qs ? `?${qs}` : ""}`);
}

export function fetchReview(id) {
  return request(`/reviews/${id}`);
}

export function patchComment(reviewId, commentId, patch) {
  return request(`/reviews/${reviewId}/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function pushReview(reviewId, commentIds) {
  return request(`/reviews/${reviewId}/push`, {
    method: "POST",
    body: JSON.stringify({ commentIds }),
  });
}

export function addLinkedPR(owner, repo, number, url) {
  return request(`/prs/${owner}/${repo}/${number}/links`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function removeLinkedPR(owner, repo, number, linkedRepo, linkedNumber) {
  const [linkedOwner, linkedName] = linkedRepo.split("/");
  return request(`/prs/${owner}/${repo}/${number}/links/${linkedOwner}/${linkedName}/${linkedNumber}`, {
    method: "DELETE",
  });
}

export function fetchUsage() {
  return request("/usage");
}
