import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRecapSchema, type SessionRecap } from '@memvora/contracts';
import { Check } from 'typebox/value';
import { formatSessionRecap, readSessionRecap } from './session-recap.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const token = 'private-local-recap-test-token-at-least-32-characters';

function fixture(): SessionRecap {
  const steps = Array.from({ length: 40 }, (_item, index) => ({
    sequence: index < 20 ? index + 1 : index + 6,
    eventId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    command: index % 2 ? 'node verify.js' : 'node reproduce.js',
    outcome: index % 2 ? 'Exited with code 0' : 'Exited with code 1',
    outputExcerpt: 'Explicit fixture output',
    diffSummary: 'Before and after snapshots differ; inspect evidence.',
  }));
  return {
    session: {
      id: sessionId,
      repositoryId,
      title: 'Explicit recap test fixture',
      status: 'closed',
      createdAt: '2026-10-21T09:00:00.000Z',
      closedAt: '2026-10-21T10:00:00.000Z',
      eventCount: 45,
      memoryCount: 0,
    },
    generatedAt: '2026-10-21T10:01:00.000Z',
    mode: 'observed',
    label: 'Observed investigation recap — deterministic, not AI-generated',
    summary: 'Fixture observations: earlier failures and later checks; no causal fix is inferred.',
    coverage: {
      totalEvents: 45,
      includedEvents: 40,
      omittedEvents: 5,
      eventLimit: 40,
      selection: 'first_and_last',
    },
    counts: {
      passed: 20,
      failed: 20,
      interrupted: 0,
      spawnFailed: 0,
      incomplete: 0,
      withDiffs: 40,
      incompleteCapture: 0,
    },
    steps,
    sources: steps.map((step) => ({
      id: step.eventId,
      kind: 'event',
      repositoryId,
      locator: `/v1/events/${step.eventId}`,
    })),
    uncertainty: [
      'Five middle attempts are omitted. Passing checks do not establish a causal fix.',
    ],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('CLI observed investigation recap', () => {
  it('reads only the explicit recap route and fails closed on an unexpected response', async () => {
    const recap = fixture();
    expect(Check(SessionRecapSchema, recap)).toBe(true);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(recap)));
    vi.stubGlobal('fetch', fetcher);
    await expect(readSessionRecap('http://127.0.0.1:4000', token, sessionId)).resolves.toEqual(
      recap,
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/sessions/${sessionId}/recap`,
    );
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    await expect(readSessionRecap('http://127.0.0.1:4000', token, '../private')).rejects.toThrow(
      'UUID',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...recap, mode: 'ai', rawEvents: ['must-not-print'] })),
    );
    await expect(readSessionRecap('http://127.0.0.1:4000', token, sessionId)).rejects.toThrow(
      'shared runtime contract',
    );
  });

  it('prints chronological citations, selection coverage and uncertainty without terminal controls', () => {
    const recap = fixture();
    recap.session.title = '\u001b[31mExplicit fixture\u001b[0m';
    recap.steps[0]!.command = 'node\nreproduce.js\u0007';
    recap.steps[0]!.outputExcerpt = '界😀'.repeat(150);
    const output = formatSessionRecap(recap);
    expect(output).toContain(recap.label);
    expect(output).toContain('Coverage: 40/45 accepted events; 5 omitted (first_and_last).');
    expect(output).toContain('Included outcomes: 20 passed, 20 failed');
    expect(output).toContain(
      'Five middle attempts are omitted. Passing checks do not establish a causal fix.',
    );
    expect(output).toContain(
      `1. node reproduce.js — Exited with code 1 [${recap.steps[0]!.eventId}]`,
    );
    expect(output.indexOf(`1. node`)).toBeLessThan(output.indexOf('26. node'));
    for (const source of recap.sources)
      expect(output).toContain(`[${source.id}] ${source.locator}`);
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
    expect(output).not.toContain(token);
    expect(output).toContain('…');
    expect(recap.steps[0]!.outputExcerpt).toBe('界😀'.repeat(150));
  });
});
