import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { GitCommitShaSchema, type CapturedEvent } from '@memvora/contracts';
import { gitDiffSummary, sharedDiffBaseline } from './git-evidence.js';

type Evidence = Pick<CapturedEvent, 'git' | 'diffs'>;
const start = 'a'.repeat(40);
function evidence(before = 'retained text', after = before, commit = start): Evidence {
  return {
    git: { commitSha: commit, dirty: true },
    diffs: [
      { phase: 'before', text: before, truncatedBytes: 0, baselineCommitSha: commit },
      { phase: 'after', text: after, truncatedBytes: 0, baselineCommitSha: commit },
    ],
  };
}

describe('explicit Git evidence comparison', () => {
  it('never infers a shared baseline from legacy HEAD metadata or identical retained text', () => {
    const legacy = evidence();
    for (const diff of legacy.diffs) delete diff.baselineCommitSha;
    expect(sharedDiffBaseline(legacy)).toBeNull();
    expect(gitDiffSummary(legacy)).toContain('Baseline not recorded');
    expect(gitDiffSummary(legacy)).toContain('comparison unavailable');
    expect(gitDiffSummary(legacy)).not.toMatch(/texts (?:match|differ)/u);

    legacy.diffs[0]!.baselineCommitSha = start;
    expect(sharedDiffBaseline(legacy)).toBeNull();
    expect(gitDiffSummary(legacy)).not.toMatch(/texts (?:match|differ)/u);

    const unknownStart = evidence();
    unknownStart.git.commitSha = null;
    expect(sharedDiffBaseline(unknownStart)).toBeNull();
    expect(gitDiffSummary(unknownStart)).not.toMatch(/texts (?:match|differ)/u);
  });

  it.each([40, 64])('compares explicit %i-character hashes case-insensitively', (length) => {
    const commit = 'a'.repeat(length);
    const captured = evidence('', '', commit);
    captured.diffs[1]!.baselineCommitSha = commit.toUpperCase();
    captured.git.afterCommitSha = commit.toUpperCase();
    expect(Check(GitCommitShaSchema, commit)).toBe(true);
    expect(sharedDiffBaseline(captured)).toBe(commit);
    expect(gitDiffSummary(captured)).toContain('Captured snapshot texts match');
    expect(gitDiffSummary(captured)).not.toContain('Observed HEAD differs');

    captured.diffs[1]!.text = 'a different captured snapshot';
    expect(gitDiffSummary(captured)).toContain('Captured snapshot texts differ');
  });

  it('retains a common-baseline comparison when the separately observed HEAD changes', () => {
    const captured = evidence('pre-existing edit', 'pre-existing edit plus interval change');
    captured.git.afterCommitSha = 'b'.repeat(40);
    const summary = gitDiffSummary(captured);
    expect(sharedDiffBaseline(captured)).toBe(start);
    expect(summary).toContain('Baseline: pre-command commit');
    expect(summary).toContain('Captured snapshot texts differ');
    expect(summary).toContain('Observed HEAD differs after execution');
    expect(summary).not.toMatch(/caused|fixed|attributed/u);
  });

  it('rejects differing baselines instead of comparing text from different commits', () => {
    const captured = evidence();
    captured.diffs[1]!.baselineCommitSha = 'b'.repeat(40);
    expect(sharedDiffBaseline(captured)).toBeNull();
    expect(gitDiffSummary(captured)).not.toMatch(/texts (?:match|differ)/u);
    captured.diffs[0]!.baselineCommitSha = 'b'.repeat(40);
    expect(sharedDiffBaseline(captured)).toBeNull();
  });

  it.each([
    '',
    'a'.repeat(39),
    'a'.repeat(41),
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(40),
    `${start}\n`,
    `${start}\r\n`,
  ])('requires a full exact SHA, rejecting %j', (invalidHash) => {
    expect(Check(GitCommitShaSchema, invalidHash)).toBe(false);
    const invalidStart = evidence('', '', invalidHash);
    expect(sharedDiffBaseline(invalidStart)).toBeNull();
    expect(gitDiffSummary(invalidStart)).not.toMatch(/texts (?:match|differ)/u);
    const invalidBaseline = evidence();
    invalidBaseline.diffs[1]!.baselineCommitSha = invalidHash;
    expect(sharedDiffBaseline(invalidBaseline)).toBeNull();
  });

  it('withholds comparison on Git failures, truncation, missing phases and duplicate phases', () => {
    const failed = evidence();
    failed.git.error = 'after HEAD (failed)';
    failed.git.afterCommitSha = null;
    const truncated = evidence();
    truncated.diffs[1]!.truncatedBytes = 1;
    const missing = evidence();
    missing.diffs.pop();
    const duplicate = evidence();
    duplicate.diffs[1]!.phase = 'before';
    const absent = evidence();
    absent.diffs = [];
    for (const captured of [failed, truncated, missing, duplicate, absent]) {
      expect(gitDiffSummary(captured)).not.toMatch(/texts (?:match|differ)/u);
    }
    expect(gitDiffSummary(failed)).toContain('Git probe failed');
    expect(gitDiffSummary(failed)).toContain('After-command HEAD unavailable');
    expect(gitDiffSummary(truncated)).toContain('Snapshot text truncated');
    expect(gitDiffSummary(absent)).toContain('No diff snapshots');
  });

  it('compares captured text before printable normalization could erase a difference', () => {
    const captured = evidence('visible\u001b[31m\u0007', 'visible');
    expect(gitDiffSummary(captured)).toContain('Captured snapshot texts differ');
    expect(gitDiffSummary(captured)).not.toContain('\u001b');
  });

  it('keeps the maximum supported two-snapshot summary within the recap budget without leaking evidence', () => {
    for (const baselineKnown of [false, true]) {
      for (const afterCommitSha of [undefined, null, 'b'.repeat(64)]) {
        const captured = evidence('PrivateDiffFixture'.repeat(100), 'other retained text');
        captured.git.error = 'PrivateGitDiagnosticFixture'.repeat(20);
        if (afterCommitSha !== undefined) captured.git.afterCommitSha = afterCommitSha;
        for (const diff of captured.diffs) {
          diff.truncatedBytes = Number.MAX_SAFE_INTEGER;
          if (!baselineKnown) delete diff.baselineCommitSha;
        }
        const summary = gitDiffSummary(captured);
        expect(summary.length).toBeLessThanOrEqual(300);
        expect(summary).not.toContain('PrivateDiffFixture');
        expect(summary).not.toContain('PrivateGitDiagnosticFixture');
      }
    }
  });
});
