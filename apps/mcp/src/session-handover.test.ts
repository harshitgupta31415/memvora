import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import {
  SessionHandoverSchema,
  type HandoverEvent,
  type SessionHandover,
} from '@memvora/contracts';
import { toolResult } from './client.js';
import { buildSessionHandoverPreview, HANDOVER_PREVIEW_BYTE_LIMIT } from './session-handover.js';

function fixture(): SessionHandover {
  const repositoryId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '2026-10-21T00:00:00.000Z';
  const events: HandoverEvent[] = Array.from({ length: 140 }, (_item, index) => ({
    eventId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    repositoryId,
    sessionId,
    sequence: index < 120 ? index + 1 : index + 861,
    startedAt: timestamp,
    endedAt: timestamp,
    commandExcerpt: 'node explicit-fixture.js',
    commandTruncated: false,
    cwdExcerpt: 'FULL_PRIVATE_CWD_FIXTURE',
    cwdTruncated: false,
    git: { commitSha: 'a'.repeat(64), dirty: true, error: null },
    outcome: { kind: 'completed', exitCode: 0, signal: null, error: null },
    capture: { complete: false, truncatedBytes: 999999, redacted: true },
    outputExcerpt: 'FULL_OUTPUT_MUST_BE_OMITTED',
    outputTruncated: true,
    diffs: [
      {
        phase: 'before',
        text: 'FULL_BEFORE_DIFF_MUST_BE_OMITTED',
        excerptTruncated: false,
        capturedTruncatedBytes: 1,
      },
      {
        phase: 'after',
        text: 'FULL_AFTER_DIFF_MUST_BE_OMITTED',
        excerptTruncated: true,
        capturedTruncatedBytes: 2,
      },
    ],
  }));
  const source = (event: HandoverEvent) => ({
    id: event.eventId,
    repositoryId,
    kind: 'event' as const,
    locator: `/v1/events/${event.eventId}`,
  });
  const selected = events.filter((_event, index) => index < 20 || index >= 120);
  const session = {
    id: sessionId,
    repositoryId,
    title: 'Explicit maximum handover preview fixture',
    status: 'open' as const,
    createdAt: timestamp,
    closedAt: null,
    eventCount: 1000,
    memoryCount: 0,
  };
  return {
    schemaVersion: 1,
    kind: 'memvora_investigation_handover',
    generatedAt: timestamp,
    repository: { id: repositoryId, name: 'Fixture repository', remoteUrl: null },
    session,
    recap: {
      session,
      generatedAt: timestamp,
      mode: 'observed',
      label: 'Observed investigation recap — deterministic, not AI-generated',
      summary: 'Explicit synthetic fixture recap',
      coverage: {
        totalEvents: 1000,
        includedEvents: 40,
        omittedEvents: 960,
        eventLimit: 40,
        selection: 'first_and_last',
      },
      counts: {
        passed: 40,
        failed: 0,
        interrupted: 0,
        spawnFailed: 0,
        incomplete: 0,
        withDiffs: 40,
        incompleteCapture: 40,
      },
      steps: selected.map((event) => ({
        sequence: event.sequence,
        eventId: event.eventId,
        command: 'fixture',
        outcome: 'Exited with code 0',
        outputExcerpt: 'Fixture output',
        diffSummary: 'Fixture snapshots differ',
      })),
      sources: selected.map(source),
      uncertainty: ['Do not infer a causal fix from these unexecuted fixture metadata.'],
    },
    notes: Array.from({ length: 10 }, (_item, index) => ({
      id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
      repositoryId,
      sessionId,
      kind: 'resolution',
      body: 'Explicit user-authored fixture claim',
      author: { id: '55555555-5555-4555-8555-555555555555', name: 'Fixture author' },
      createdAt: timestamp,
      label: 'User-authored — not independently verified',
      sources: events.slice(20 + index * 10, 30 + index * 10).map(source),
    })),
    coverage: {
      totalEvents: 1000,
      includedEvents: 140,
      omittedEvents: 860,
      recapEvents: 40,
      eventLimit: 140,
      totalNotes: 12,
      includedNotes: 10,
      omittedNotes: 2,
      noteLimit: 10,
      selection: 'first_and_last_plus_note_sources',
      repositoryFilesIncluded: false,
      derivedMemoriesIncluded: false,
    },
    events,
    excerptLimit: 6000,
    serializedByteLimit: 2097152,
    notices: ['Explicit synthetic fixture; no execution or provider access.'],
  };
}

describe('MCP portable handover manifest and preview', () => {
  it.each(['\u0000', '\\"', '界😀'])(
    'keeps all 140 events, ten notes and 140 source memberships under escaped %j pressure',
    async (character) => {
      const input = fixture();
      const sized = (maximum: number) =>
        character
          .repeat(maximum)
          .slice(0, maximum)
          .replace(/[\uD800-\uDBFF]$/u, '');
      input.repository.name = sized(120);
      input.repository.remoteUrl = sized(2048);
      input.session.title = sized(200);
      input.events = input.events.map((event) => ({ ...event, commandExcerpt: sized(512) }));
      input.notes = input.notes.map((note) => ({
        ...note,
        body: sized(4000),
        author: { ...note.author, name: sized(100) },
      }));
      input.recap.summary = sized(1000);
      input.recap.uncertainty = Array.from({ length: 8 }, () => sized(500));
      input.notices = Array.from({ length: 12 }, () => sized(800));
      expect(Check(SessionHandoverSchema, input)).toBe(true);
      const result = buildSessionHandoverPreview(input);
      expect(result.fullReportIncluded).toBe(false);
      expect(result.outputExcerptsIncluded).toBe(false);
      expect(result.diffTextIncluded).toBe(false);
      expect(result.coverage).toEqual(input.coverage);
      expect(result.events.map((event) => [event.eventId, event.sequence])).toEqual(
        input.events.map((event) => [event.eventId, event.sequence]),
      );
      expect(result.notes.map((note) => note.id)).toEqual(input.notes.map((note) => note.id));
      expect(result.recap.sources).toEqual(input.recap.sources);
      expect(result.recap.eventIds).toEqual(input.recap.steps.map((step) => step.eventId));
      for (const [index, note] of result.notes.entries()) {
        expect(note.sources).toEqual(input.notes[index]!.sources);
        expect(note.author).toEqual(input.notes[index]!.author);
        expect(note.label).toBe('User-authored — not independently verified');
      }
      for (const [index, event] of result.events.entries()) {
        expect(event.capture).toEqual(input.events[index]!.capture);
        expect(event.commitSha).toBe(input.events[index]!.git.commitSha);
        expect(event.diffPhases).toEqual(['before', 'after']);
      }
      const response = await toolResult(async () => result);
      expect(response.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(
        HANDOVER_PREVIEW_BYTE_LIMIT,
      );
      expect(JSON.stringify(response)).not.toContain('FULL_OUTPUT_MUST_BE_OMITTED');
      expect(JSON.stringify(response)).not.toContain('FULL_AFTER_DIFF_MUST_BE_OMITTED');
      expect(JSON.stringify(response)).not.toContain('FULL_PRIVATE_CWD_FIXTURE');
      expect(JSON.stringify(response)).not.toMatch(
        /\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i,
      );
      expect(result.fullReportDownload.cli).toContain('session export');
      expect(buildSessionHandoverPreview(input)).toEqual(result);
    },
  );

  it('preserves exact per-phase baselines and after-HEAD observations without inventing legacy metadata', async () => {
    const input = fixture();
    const first = input.events[0]!;
    first.git.afterCommitSha = 'b'.repeat(64);
    first.diffs.forEach((diff) => {
      diff.baselineCommitSha = first.git.commitSha!;
    });
    const second = input.events[1]!;
    second.git.commitSha = 'c'.repeat(40);
    second.git.afterCommitSha = null;
    second.diffs[0]!.baselineCommitSha = second.git.commitSha;
    expect(Check(SessionHandoverSchema, input)).toBe(true);

    const result = buildSessionHandoverPreview(input);
    expect(result.events[0]!.afterCommitSha).toBe('b'.repeat(64));
    expect(result.events[0]!.diffBaselines).toEqual([
      { phase: 'before', baselineCommitSha: 'a'.repeat(64) },
      { phase: 'after', baselineCommitSha: 'a'.repeat(64) },
    ]);
    expect(result.events[1]!.afterCommitSha).toBeNull();
    expect(result.events[1]!.diffBaselines).toEqual([
      { phase: 'before', baselineCommitSha: 'c'.repeat(40) },
      { phase: 'after' },
    ]);
    expect(Object.hasOwn(result.events[2]!, 'afterCommitSha')).toBe(false);
    expect(Object.hasOwn(result.events[2]!, 'diffBaselines')).toBe(false);
    expect(result.events[2]!.diffPhases).toEqual(['before', 'after']);
    expect(result.events.map((event) => event.eventId)).toEqual(
      input.events.map((event) => event.eventId),
    );
    const response = await toolResult(async () => result);
    expect(response.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(
      HANDOVER_PREVIEW_BYTE_LIMIT,
    );
    expect(JSON.stringify(response)).not.toContain('FULL_AFTER_DIFF_MUST_BE_OMITTED');
    expect(Object.hasOwn(input.events[2]!.git, 'afterCommitSha')).toBe(false);
  });

  it('rejects a missing note-linked original event or changed source scope', () => {
    const input = fixture();
    input.events.splice(20, 1);
    input.coverage.includedEvents--;
    input.coverage.omittedEvents++;
    expect(() => buildSessionHandoverPreview(input)).toThrow('source membership');
    const changed = fixture();
    changed.notes[0]!.sources[0]!.repositoryId = '66666666-6666-4666-8666-666666666666';
    expect(() => buildSessionHandoverPreview(changed)).toThrow('source membership');
  });
});
