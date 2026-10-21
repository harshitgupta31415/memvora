import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { SessionHandoverSchema } from '@memvora/contracts';
import type { CapturedEvent, Repository, SessionNote } from '@memvora/contracts';
import type { SessionHandoverEvidence } from './local-service.js';
import { deriveSessionHandover } from './session-handover.js';

function fixture(count = 3) {
  const time = '2026-10-21T00:00:00.000Z';
  const repository: Repository = {
    id: randomUUID(),
    workspaceId: randomUUID(),
    name: 'Portable fixture',
    localPath: 'private-registration-path',
    remoteUrl: null,
    status: 'active' as const,
    createdAt: time,
  };
  const session = {
    id: randomUUID(),
    repositoryId: repository.id,
    title: 'Investigate failing validation',
    status: 'open' as const,
    createdAt: time,
    closedAt: null,
    eventCount: count,
    memoryCount: 0,
  };
  const events: CapturedEvent[] = Array.from({ length: count }, (_, index) => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: index + 1,
    startedAt: time,
    endedAt: time,
    command: { executable: 'node', args: ['check.cjs'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: 'a'.repeat(40), dirty: true },
    outcome: { kind: 'completed', exitCode: index ? 0 : 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [],
    diffs: [],
  }));
  const note: SessionNote = {
    id: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    kind: 'resolution',
    body: 'My reported conclusion.',
    author: { id: randomUUID(), name: 'Test author' },
    createdAt: time,
    label: 'User-authored — not independently verified',
    sources: events.length
      ? [
          {
            id: events[0]!.eventId,
            repositoryId: repository.id,
            kind: 'event',
            locator: `/v1/events/${events[0]!.eventId}`,
          },
        ]
      : [],
  };
  const recapEvents = count <= 40 ? events : [...events.slice(0, 20), ...events.slice(-20)];
  const evidence: SessionHandoverEvidence = {
    repository,
    recapEvidence: { session, events: recapEvents, totalEventCount: count },
    events: recapEvents,
    totalEventCount: count,
    notes: [note],
    totalNoteCount: 1,
  };
  return { evidence, events, note };
}

describe('portable investigation handover derivation', () => {
  it('preserves identity, observed counts and author claims without exporting registration metadata or changing evidence', () => {
    const { evidence, events, note } = fixture();
    const before = JSON.stringify(evidence);
    const report = deriveSessionHandover(evidence);
    expect(Check(SessionHandoverSchema, report)).toBe(true);
    expect(report.events.map((event) => event.eventId)).toEqual(
      events.map((event) => event.eventId),
    );
    expect(report.recap.counts).toMatchObject({ failed: 1, passed: 2 });
    expect(report.notes[0]).toEqual(note);
    expect(JSON.stringify(report)).not.toContain('private-registration-path');
    expect(report.repository).not.toHaveProperty('workspaceId');
    expect(report.notices.join(' ')).toContain('not independently verified');
    expect(report.notices.join(' ')).toContain('does not follow later deletion');
    expect(JSON.stringify(evidence)).toBe(before);
  });

  it('supports journal-only and empty investigations with no manufactured attempt', () => {
    const { evidence } = fixture(0);
    expect(deriveSessionHandover(evidence).coverage).toMatchObject({
      includedEvents: 0,
      includedNotes: 1,
    });
    evidence.notes = [];
    evidence.totalNoteCount = 0;
    expect(deriveSessionHandover(evidence).recap.summary).toContain('No accepted commands');
  });

  it('includes omitted-middle attempts cited by recent notes while keeping recap counts separate', () => {
    const { evidence, events, note } = fixture(200);
    note.sources[0]!.id = events[75]!.eventId;
    evidence.events = [
      ...evidence.recapEvidence.events.slice(0, 20),
      events[75]!,
      ...evidence.recapEvidence.events.slice(20),
    ];
    const report = deriveSessionHandover(evidence);
    expect(report.coverage).toMatchObject({
      totalEvents: 200,
      includedEvents: 41,
      omittedEvents: 159,
      recapEvents: 40,
    });
    expect(report.recap.coverage).toMatchObject({ includedEvents: 40, omittedEvents: 160 });
    expect(report.notes[0]!.sources[0]!.locator).toBe(`/v1/events/${events[75]!.eventId}`);
    expect(report.events.find((event) => event.eventId === note.sources[0]!.id)).toBeDefined();
    expect(report.recap.counts.passed).toBe(39);
  });

  it('normalizes then redacts joined output, labels and diffs, while retaining capture and export truncation separately', () => {
    const { evidence, events } = fixture(1);
    evidence.repository.remoteUrl = 'https://person:privatepass@example.test/repo';
    events[0]!.output = [
      { ordinal: 0, stream: 'stdout', text: 'pass\u001b[31mword=' },
      { ordinal: 1, stream: 'stdout', text: 'secret-value\r\n' + '😀'.repeat(4000) },
    ];
    events[0]!.diffs = [{ phase: 'before', text: 'to\u202eken=hidden-value', truncatedBytes: 17 }];
    events[0]!.capture.truncatedBytes = 7;
    const report = deriveSessionHandover(evidence);
    expect(report.events[0]!.outputExcerpt).toContain('password=[REDACTED]');
    expect(JSON.stringify(report)).not.toMatch(
      /secret-value|hidden-value|privatepass|\\u001b|\\u202e/u,
    );
    expect(report.events[0]!.outputTruncated).toBe(true);
    expect(report.events[0]!.capture.truncatedBytes).toBe(7);
    expect(report.events[0]!.diffs[0]).toMatchObject({
      phase: 'before',
      excerptTruncated: false,
      capturedTruncatedBytes: 17,
    });
    expect(report.events[0]!.outputExcerpt).not.toMatch(/[\uD800-\uDBFF]…$/u);
  });

  it('bounds aggregate UTF-8 JSON without dropping any note or event citation', () => {
    const { evidence, events, note } = fixture(140);
    const middle = events.slice(20, 120);
    evidence.notes = Array.from({ length: 10 }, (_, index) => ({
      ...note,
      id: randomUUID(),
      sources: middle.slice(index * 10, index * 10 + 10).map((event) => ({
        id: event.eventId,
        kind: 'event' as const,
        repositoryId: event.repositoryId,
        locator: `/v1/events/${event.eventId}`,
      })),
    }));
    evidence.totalNoteCount = 25;
    evidence.events = events;
    for (const event of events) {
      event.output = [{ ordinal: 0, stream: 'stdout', text: '界'.repeat(6001) }];
      event.diffs = ['before', 'after'].map((phase) => ({
        phase: phase as 'before' | 'after',
        text: '界'.repeat(6001),
        truncatedBytes: 0,
      }));
    }
    const report = deriveSessionHandover(evidence);
    expect(report.excerptLimit).toBeLessThan(6000);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2097152);
    expect(report.events).toHaveLength(140);
    expect(report.notes).toHaveLength(10);
    expect(report.coverage.omittedNotes).toBe(15);
    expect(
      report.notes
        .flatMap((entry) => entry.sources)
        .every((source) => report.events.some((event) => event.eventId === source.id)),
    ).toBe(true);
  });

  it('rejects foreign, missing, duplicated or contradictory offline evidence', () => {
    for (const mutate of [
      (value: SessionHandoverEvidence) => {
        value.events[0]!.sessionId = randomUUID();
      },
      (value: SessionHandoverEvidence) => {
        value.notes[0]!.sources[0]!.id = randomUUID();
      },
      (value: SessionHandoverEvidence) => {
        value.events.push(value.events[0]!);
      },
      (value: SessionHandoverEvidence) => {
        value.recapEvidence.events = structuredClone(value.recapEvidence.events);
        value.recapEvidence.events[0]!.outcome.exitCode = 42;
      },
      (value: SessionHandoverEvidence) => {
        value.totalNoteCount = 2;
      },
    ]) {
      const { evidence } = fixture();
      mutate(evidence);
      expect(() => deriveSessionHandover(evidence)).toThrow('inconsistent');
    }
  });
});
