// Shared in-memory cache of the last GET /api/prs result, so screens that
// only need to look up one PR's metadata (e.g. the Review screen) don't have
// to re-run the full assigned-PRs fetch just to read one entry out of it.
let cachedPrs = null;

export function getCachedPrs() {
  return cachedPrs;
}

export function setCachedPrs(prs) {
  cachedPrs = prs;
}
