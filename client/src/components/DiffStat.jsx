const MAX_BLOCKS = 5;

export function DiffStat({ additions, deletions }) {
  const total = additions + deletions;
  const addBlocks = total === 0 ? 0 : Math.round((additions / total) * MAX_BLOCKS);
  const delBlocks = total === 0 ? 0 : MAX_BLOCKS - addBlocks;

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs tabular-nums"
      title={`+${additions} -${deletions}`}
    >
      <span className="font-medium text-emerald-600 dark:text-emerald-400">+{additions}</span>
      <span className="font-medium text-red-600 dark:text-red-400">-{deletions}</span>
      <span className="inline-flex gap-0.5">
        {Array.from({ length: addBlocks }).map((_, i) => (
          <span key={`a${i}`} className="h-2 w-2 rounded-[2px] bg-emerald-500" />
        ))}
        {Array.from({ length: delBlocks }).map((_, i) => (
          <span key={`d${i}`} className="h-2 w-2 rounded-[2px] bg-red-500" />
        ))}
      </span>
    </span>
  );
}
