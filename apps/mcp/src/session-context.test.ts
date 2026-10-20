import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CapturedEvent, Memory, SessionEventsPage } from '@memvora/contracts';
import { buildSessionContextResult, SESSION_CONTEXT_BYTE_LIMIT } from './session-context.js';

const unicode = '界😀é';
const observedLabel = 'Observed evidence summary — deterministic, not AI-generated';

function fixture(): SessionEventsPage {
  const repositoryId = randomUUID();
  const sessionId = randomUUID();
  const timestamp = '2026-10-21T09:00:00.000Z';
  const events: CapturedEvent[] = Array.from({ length: 10 }, (_value, index) => ({
    eventId: randomUUID(),
    repositoryId,
    sessionId,
    sequence: index + 1,
    startedAt: timestamp,
    endedAt: timestamp,
    command: {
      executable: unicode.repeat(1024),
      shell: unicode.repeat(30),
      args: Array.from({ length: 256 }, () => unicode.repeat(2048)),
    },
    cwd: unicode.repeat(512),
    git: { commitSha: 'a'.repeat(40), dirty: true, error: unicode.repeat(125) },
    outcome: {
      kind: 'spawn_failed',
      exitCode: null,
      signal: null,
      error: { code: 'FIXTURE_ERROR', message: unicode.repeat(250) },
    },
    capture: { complete: false, truncatedBytes: 12345, redacted: true },
    output: Array.from({ length: 4 }, (_item, ordinal) => ({
      stream: 'stderr' as const,
      ordinal,
      text: unicode.repeat(2048),
    })),
    diffs: [
      { phase: 'before', text: unicode.repeat(2048), truncatedBytes: 234 },
      { phase: 'after', text: unicode.repeat(2048), truncatedBytes: 345 },
    ],
  }));
  const sources = events.map((event) => ({
    id: event.eventId,
    kind: 'event' as const,
    repositoryId,
    locator: `/v1/events/${event.eventId}`,
  }));
  const memories: Memory[] = events.map((event) => ({
    id: event.eventId,
    repositoryId,
    sessionId,
    title: unicode.repeat(2000),
    summary: unicode.repeat(12000),
    mode: 'observed',
    label: observedLabel,
    outcome: unicode.repeat(2000),
    createdAt: timestamp,
    steps: Array.from({ length: 30 }, () => ({
      text: unicode.repeat(2000),
      sourceIds: sources.map((source) => source.id),
    })),
    sources: [...sources, ...sources],
    uncertainty: Array.from({ length: 20 }, () => unicode.repeat(2000)),
    provenance: {
      provider: unicode.repeat(1000),
      model: unicode.repeat(1000),
      promptVersion: unicode.repeat(1000),
    },
  }));
  return {
    session: {
      id: sessionId,
      repositoryId,
      title: unicode.repeat(2000),
      status: 'open',
      createdAt: timestamp,
      closedAt: null,
      eventCount: 1000,
      memoryCount: 10,
    },
    events,
    memories,
    page: {
      snapshotEventCount: 125,
      returnedEvents: 10,
      firstSequence: 1,
      lastSequence: 10,
      olderCursor: 'a'.repeat(2048),
      newerCursor: 'b'.repeat(2048),
    },
  };
}

describe('aggregate MCP session history context budget', () => {
  it('keeps every page member, identity, outcome and cursor below the byte budget with large Unicode evidence', () => {
    const input = fixture();
    const result = buildSessionContextResult(input);
    const encoded = JSON.stringify(result);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(SESSION_CONTEXT_BYTE_LIMIT);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(128 * 1024);
    expect(result.page).toEqual(input.page);
    expect(result.session.id).toBe(input.session.id);
    expect(result.events.map((event) => event.eventId)).toEqual(
      input.events.map((event) => event.eventId),
    );
    expect(result.memories.map((memory) => memory.id)).toEqual(
      input.memories.map((memory) => memory.id),
    );
    for (const [index, event] of result.events.entries()) {
      expect(event.sequence).toBe(input.events[index]!.sequence);
      expect(event.outcome.kind).toBe(input.events[index]!.outcome.kind);
      expect(event.outcome.exitCode).toBeNull();
      expect(event.capture).toEqual(input.events[index]!.capture);
      expect(event.totalOutputChunks).toBe(4);
      expect(event.command.totalArguments).toBe(256);
    }
    const ids = new Set(input.events.map((event) => event.eventId));
    for (const memory of result.memories) {
      expect(memory.label).toBe(observedLabel);
      expect(memory.mode).toBe('observed');
      expect(new Set(memory.sources.map((source) => source.id))).toEqual(ids);
      expect(memory.uncertaintyExcerpted).toBe(true);
      for (const step of memory.steps)
        for (const id of step.sourceIds) expect(ids.has(id)).toBe(true);
    }
    expect(result.evidenceNotice).toContain('omitted uncertainty');
    expect(encoded).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i);
    expect(buildSessionContextResult(input)).toEqual(result);
    expect(input.events[0]!.command.args).toHaveLength(256);
    expect(input.memories[0]!.steps).toHaveLength(30);
  });

  it('retains honest empty-page navigation and rejects unresolved page provenance', () => {
    const input = fixture();
    const empty = buildSessionContextResult({
      ...input,
      events: [],
      memories: [],
      page: {
        snapshotEventCount: 0,
        returnedEvents: 0,
        firstSequence: null,
        lastSequence: null,
        olderCursor: null,
        newerCursor: null,
      },
    });
    expect(empty.events).toEqual([]);
    expect(empty.memories).toEqual([]);
    expect(empty.page.olderCursor).toBeNull();
    const invalid = fixture();
    invalid.memories[0]!.steps[0]!.sourceIds = [randomUUID()];
    expect(() => buildSessionContextResult(invalid)).toThrow('unresolved source');
    const outside = fixture();
    outside.memories[0]!.sources[0]!.id = randomUUID();
    expect(() => buildSessionContextResult(outside)).toThrow('outside');
  });
});
