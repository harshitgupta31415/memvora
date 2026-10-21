import { gitCommitShaPattern, type CapturedEvent } from '@memvora/contracts';

const sha = new RegExp(gitCommitShaPattern);
type BaselineEvidence = {
  git: { commitSha: string | null };
  diffs: readonly { baselineCommitSha?: string }[];
};

/** Missing historical provenance never becomes an inferred common baseline. */
export function sharedDiffBaseline(event: BaselineEvidence): string | null {
  const start = event.git.commitSha;
  if (!start || !sha.test(start) || !event.diffs.length) return null;
  return event.diffs.every(
    (diff) =>
      diff.baselineCommitSha !== undefined &&
      sha.test(diff.baselineCommitSha) &&
      diff.baselineCommitSha.toLowerCase() === start.toLowerCase(),
  )
    ? start
    : null;
}

/** Compare captured text only, before any display normalization or excerpt clipping. */
export function gitDiffSummary(event: Pick<CapturedEvent, 'git' | 'diffs'>): string {
  const parts = event.diffs.map(
    (diff) =>
      `${diff.phase === 'before' ? 'Before' : 'After'} snapshot: ${diff.text ? 'nonempty' : 'empty'}`,
  );
  const baseline = sharedDiffBaseline(event);
  const before = event.diffs.filter((diff) => diff.phase === 'before');
  const after = event.diffs.filter((diff) => diff.phase === 'after');
  const truncated = event.diffs.some((diff) => diff.truncatedBytes > 0);
  if (!event.diffs.length) parts.push('No diff snapshots');
  else if (!baseline) parts.push('Baseline not recorded; comparison unavailable');
  else {
    parts.push('Baseline: pre-command commit');
    if (event.git.error || truncated || before.length !== 1 || after.length !== 1)
      parts.push('Comparison unavailable');
    else
      parts.push(
        before[0]!.text === after[0]!.text
          ? 'Captured snapshot texts match'
          : 'Captured snapshot texts differ',
      );
  }
  if (event.git.error) parts.push('Git probe failed');
  if (truncated) parts.push('Snapshot text truncated');
  if (event.git.afterCommitSha === null) parts.push('After-command HEAD unavailable');
  else if (
    event.git.afterCommitSha &&
    event.git.commitSha &&
    event.git.afterCommitSha.toLowerCase() !== event.git.commitSha.toLowerCase()
  )
    parts.push('Observed HEAD differs after execution');
  return `${parts.join('. ')}.`;
}
