// Bounded-parallelism map: runs `fn` over `items` with at most `limit` in flight at
// once. Used anywhere we'd otherwise fire one GitHub/Claude call per item sequentially
// (slow) or all at once (rate-limit/resource risk) — see prs.js's PR-list refresh and
// reviews.js's batch review.
export async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
