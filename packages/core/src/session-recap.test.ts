import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CapturedEvent, Session } from '@memvora/contracts';
import { Check } from 'typebox/value';
import { SessionRecapSchema } from '@memvora/contracts';
import { deriveSessionRecap } from './session-recap.js';

function fixture() {
  const session: Session = {
    id: randomUUID(),
    repositoryId: randomUUID(),
    title: 'Investigate a failing check',
    status: 'open',
    createdAt: '2026-10-21T00:00:00.000Z',
    closedAt: null,
    eventCount: 0,
    memoryCount: 0,
  };
  const event = (sequence: number): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: session.repositoryId,
    sessionId: session.id,
    sequence,
    startedAt: session.createdAt,
    endedAt: session.createdAt,
    command: { executable: 'node', args: ['check.cjs'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [],
    diffs: [],
  });
  return { session, event };
}

describe('observed investigation recap', () => {
  it('describes missing evidence without manufacturing attempts or a resolution', () => {
    const { session } = fixture();
    const recap = deriveSessionRecap({ session, events: [], totalEventCount: 0 });
    expect(Check(SessionRecapSchema, recap)).toBe(true);
    expect(recap.summary).toContain('No accepted commands');
    expect(recap.steps).toEqual([]);
    expect(recap.sources).toEqual([]);
    expect(recap.coverage).toMatchObject({
      totalEvents: 0,
      includedEvents: 0,
      omittedEvents: 0,
      selection: 'all',
    });
  });

  it('counts each outcome separately and cites failure followed by a successful exit without claiming a fix', () => {
    const { session, event } = fixture();
    const events = Array.from({ length: 6 }, (_value, index) => event(index + 1));
    events[0]!.outcome.exitCode = 1;
    events[2]!.outcome = { kind: 'spawn_failed', exitCode: null, signal: null };
    events[3]!.outcome = { kind: 'interrupted', exitCode: null, signal: 'SIGINT' };
    events[4]!.outcome = { kind: 'incomplete', exitCode: null, signal: null };
    events[5]!.outcome.exitCode = null;
    const recap = deriveSessionRecap({ session, events, totalEventCount: 6 });
    expect(recap.counts).toMatchObject({
      passed: 1,
      failed: 1,
      spawnFailed: 1,
      interrupted: 1,
      incomplete: 2,
    });
    expect(recap.steps.map((step) => step.eventId)).toEqual(events.map((item) => item.eventId));
    expect(recap.sources.map((source) => source.id)).toEqual(events.map((item) => item.eventId));
    expect(recap.sources.every((source) => source.locator === `/v1/events/${source.id}`)).toBe(
      true,
    );
    expect(recap.uncertainty.join(' ')).toContain('does not by itself prove');
    expect(recap.mode).toBe('observed');
    expect(Check(SessionRecapSchema, recap)).toBe(true);
  });

  it('reports omitted middle attempts explicitly and keeps counts limited to the selection', () => {
    const { session, event } = fixture();
    const events = [
      ...Array.from({ length: 20 }, (_value, index) => event(index + 1)),
      ...Array.from({ length: 20 }, (_value, index) => event(index + 181)),
    ];
    const recap = deriveSessionRecap({ session, events, totalEventCount: 200 });
    expect(recap.coverage).toEqual({
      totalEvents: 200,
      includedEvents: 40,
      omittedEvents: 160,
      eventLimit: 40,
      selection: 'first_and_last',
    });
    expect(recap.counts.passed).toBe(40);
    expect(recap.uncertainty.join(' ')).toContain('160 middle attempts');
    expect(Check(SessionRecapSchema, recap)).toBe(true);
  });

  it('shortens redacted printable evidence, orders output and flags incomplete capture and diff snapshots', () => {
    const { session, event } = fixture();
    const captured = event(1);
    captured.command.args = ['--token', `token=${'s'.repeat(50)}`, '😀'.repeat(300)];
    captured.output = [
      { ordinal: 1, stream: 'stdout', text: 'later'.repeat(1000) },
      {
        ordinal: 0,
        stream: 'stderr',
        text: `\u001b[31mfirst\u0007 token=${'p'.repeat(50)} pass\u0000word=plain-secret\u0085\n`,
      },
    ];
    captured.capture = { complete: false, truncatedBytes: 30, redacted: true };
    captured.diffs = [
      { phase: 'before', text: 'pre-existing change', truncatedBytes: 0 },
      { phase: 'after', text: 'another snapshot', truncatedBytes: 5 },
    ];
    const recap = deriveSessionRecap({ session, events: [captured], totalEventCount: 1 });
    expect(recap.steps[0]!.command.length).toBeLessThanOrEqual(300);
    expect(recap.steps[0]!.outputExcerpt.length).toBeLessThanOrEqual(600);
    expect(recap.steps[0]!.outputExcerpt).toMatch(/^\[stderr\]/);
    expect(JSON.stringify(recap)).not.toContain('s'.repeat(50));
    expect(JSON.stringify(recap)).not.toContain('p'.repeat(50));
    expect(JSON.stringify(recap)).not.toContain('plain-secret');
    expect(recap.steps[0]!.outputExcerpt).not.toContain('\u0085');
    expect(recap.steps[0]!.outputExcerpt).not.toContain('\u001b');
    expect(recap.steps[0]!.diffSummary).toContain('Snapshot texts differ');
    expect(recap.counts).toMatchObject({ withDiffs: 1, incompleteCapture: 1 });
    expect(recap.uncertainty.join(' ')).toContain('pre-existing changes');
    expect(Check(SessionRecapSchema, recap)).toBe(true);
  });

  it('reassembles consecutive stream chunks before redaction and retains stream transitions', () => {
    const { session, event } = fixture();
    const captured = event(1);
    captured.output = [
      { ordinal: 2, stream: 'stdout', text: 'validation complete' },
      { ordinal: 1, stream: 'stderr', text: 'word=joined-secret\n' },
      { ordinal: 0, stream: 'stderr', text: 'AssertionError: pass' },
    ];
    const recap = deriveSessionRecap({ session, events: [captured], totalEventCount: 1 });
    expect(recap.steps[0]!.outputExcerpt).toBe(
      '[stderr] AssertionError: password=[REDACTED]\n[stdout] validation complete',
    );
    expect(JSON.stringify(recap)).not.toContain('joined-secret');
  });

  it('fails closed on incomplete, unordered, duplicate or foreign evidence selections', () => {
    const { session, event } = fixture();
    const first = event(1);
    for (const events of [
      [first],
      [event(2), first],
      [first, first],
      [{ ...first, sessionId: randomUUID() }],
    ]) {
      expect(() => deriveSessionRecap({ session, events, totalEventCount: 2 })).toThrow(
        'inconsistent',
      );
    }
  });
});
