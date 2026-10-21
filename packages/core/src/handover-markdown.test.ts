import { describe, expect, it } from 'vitest';
import {
  SessionHandoverSchema,
  type HandoverEvent,
  type SessionHandover,
} from '@memvora/contracts';
import { Check } from 'typebox/value';
import { formatSessionHandoverMarkdown } from './handover-markdown.js';

function fixture(): SessionHandover {
  const repositoryId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '2026-10-21T00:00:00.000Z';
  const events: HandoverEvent[] = Array.from({ length: 41 }, (_item, index) => ({
    eventId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    repositoryId,
    sessionId,
    sequence: index + 1,
    startedAt: timestamp,
    endedAt: timestamp,
    commandExcerpt: 'node fixture-check.js',
    commandTruncated: false,
    cwdExcerpt: 'fixture-project',
    cwdTruncated: false,
    git: { commitSha: 'a'.repeat(40), dirty: true, error: null },
    outcome: { kind: 'completed', exitCode: 0, signal: null, error: null },
    capture: { complete: false, truncatedBytes: 12, redacted: true },
    outputExcerpt: 'Explicit unexecuted fixture output',
    outputTruncated: true,
    diffs: [
      {
        phase: 'before',
        text: 'pre-existing fixture change',
        excerptTruncated: false,
        capturedTruncatedBytes: 0,
      },
      {
        phase: 'after',
        text: 'fixture change after command',
        excerptTruncated: true,
        capturedTruncatedBytes: 9,
      },
    ],
  }));
  const selected = events.filter((_event, index) => index !== 20);
  const session = {
    id: sessionId,
    repositoryId,
    title: 'Explicit handover render fixture',
    status: 'closed' as const,
    createdAt: timestamp,
    closedAt: timestamp,
    eventCount: 41,
    memoryCount: 0,
  };
  const source = (event: HandoverEvent) => ({
    id: event.eventId,
    repositoryId,
    kind: 'event' as const,
    locator: `/v1/events/${event.eventId}`,
  });
  return {
    schemaVersion: 1,
    kind: 'memvora_investigation_handover',
    generatedAt: timestamp,
    repository: {
      id: repositoryId,
      name: 'Fixture repository',
      remoteUrl: 'https://github.com/fixture/private',
    },
    session,
    recap: {
      session,
      generatedAt: timestamp,
      mode: 'observed',
      label: 'Observed investigation recap — deterministic, not AI-generated',
      summary: 'Explicit fixture recap',
      coverage: {
        totalEvents: 41,
        includedEvents: 40,
        omittedEvents: 1,
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
        command: event.commandExcerpt,
        outcome: 'Exited with code 0',
        outputExcerpt: 'Fixture output',
        diffSummary: 'Snapshot text differs.',
      })),
      sources: selected.map(source),
      uncertainty: ['A successful command exit is not a causal fix.'],
    },
    notes: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        repositoryId,
        sessionId,
        kind: 'resolution',
        body: 'Fixture author reports a resolution; not independently verified.',
        author: { id: '55555555-5555-4555-8555-555555555555', name: 'Fixture author' },
        createdAt: timestamp,
        label: 'User-authored — not independently verified',
        sources: [source(events[20]!)],
      },
    ],
    coverage: {
      totalEvents: 41,
      includedEvents: 41,
      omittedEvents: 0,
      recapEvents: 40,
      eventLimit: 140,
      totalNotes: 1,
      includedNotes: 1,
      omittedNotes: 0,
      noteLimit: 10,
      selection: 'first_and_last_plus_note_sources',
      repositoryFilesIncluded: false,
      derivedMemoriesIncluded: false,
    },
    events,
    excerptLimit: 6000,
    serializedByteLimit: 2097152,
    notices: ['Explicit fixture notice: retained copies are independent.'],
  };
}

function outsideFences(markdown: string): string {
  const outside: string[] = [];
  let fenceLength = 0;
  for (const line of markdown.split('\n')) {
    const opening = /^(`{3,})text$/u.exec(line);
    if (!fenceLength && opening) {
      fenceLength = opening[1]!.length;
      continue;
    }
    if (fenceLength && /^`+$/u.test(line) && line.length >= fenceLength) {
      fenceLength = 0;
      continue;
    }
    if (!fenceLength) outside.push(line);
  }
  expect(fenceLength).toBe(0);
  return outside.join('\n');
}

describe('portable inert handover Markdown', () => {
  it('resolves every recap and note citation offline, including a note-linked omitted-middle event', () => {
    const report = fixture();
    expect(Check(SessionHandoverSchema, report)).toBe(true);
    const markdown = formatSessionHandoverMarkdown(report);
    const anchors = new Set(
      [...markdown.matchAll(/<a id="((?:event|note)-[a-f0-9-]+)"><\/a>/gu)].map(
        (match) => match[1],
      ),
    );
    for (const match of markdown.matchAll(/\]\(#((?:event|note)-[a-f0-9-]+)\)/gu))
      expect(anchors.has(match[1])).toBe(true);
    expect(anchors.size).toBe(42);
    expect(markdown).toContain(`](#event-${report.events[20]!.eventId})`);
    expect(markdown).toContain('recap selection of up to 40 attempts');
    expect(markdown).toContain('"includedEvents": 41');
    expect(markdown).toContain('User-authored — not independently verified');
    expect(markdown).toContain('Before-command diff snapshot');
    expect(markdown).toContain('After-command diff snapshot');
    expect(markdown).toContain('"capturedTruncatedBytes": 9');
    expect(markdown).toContain('"commitSha": "' + 'a'.repeat(40));
    expect(markdown).toContain('Later deletion, disconnect or permission changes cannot revoke');
  });

  it('keeps hostile HTML, Markdown, images and backtick fences inert in all untrusted sections', () => {
    const report = fixture();
    const hostile =
      '```````\n# INJECTED_HEADING\n<img src="https://invalid.example/pixel" onerror="alert(1)">\n![INJECTED_IMAGE](https://invalid.example/pixel)\n```````';
    report.repository.name = hostile.slice(0, 120);
    report.session.title = hostile.slice(0, 200);
    report.recap.label = hostile.slice(0, 100);
    report.recap.summary = hostile;
    report.recap.steps[0]!.command = hostile;
    report.recap.uncertainty = [hostile];
    report.notes[0]!.body = hostile;
    report.notes[0]!.author.name = hostile.slice(0, 100);
    report.events[0]!.commandExcerpt = hostile;
    report.events[0]!.outputExcerpt = hostile;
    report.events[0]!.diffs[0]!.text = hostile;
    report.notices = [hostile];
    const markdown = formatSessionHandoverMarkdown(report);
    const outside = outsideFences(markdown);
    expect(markdown).toContain('````````text');
    expect(outside).not.toContain('INJECTED');
    expect(outside).not.toContain('invalid.example');
    expect(outside).not.toContain('<img');
    expect(
      outside
        .match(/<[^>]+>/gu)
        ?.every((tag) => /^<a id="(?:event|note)-[a-f0-9-]+">$|^<\/a>$/u.test(tag)),
    ).toBe(true);
  });

  it('rejects broken offline source closure and unsafe anchor identities', () => {
    const report = fixture();
    report.events.splice(20, 1);
    expect(() => formatSessionHandoverMarkdown(report)).toThrow('unresolved offline event');
    const invalid = fixture();
    invalid.events[0]!.eventId = '"><img src=x>';
    expect(() => formatSessionHandoverMarkdown(invalid)).toThrow('invalid citation identity');
  });
});
