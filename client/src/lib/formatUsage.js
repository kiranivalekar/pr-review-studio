export function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function totalTokens(usage) {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0);
}
