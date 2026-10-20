import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRecapSchema, type SessionRecap } from '@memvora/contracts';
import { Check } from 'typebox/value';
import { request, toolResult } from './client.js';
import { buildSessionRecapResult, SESSION_RECAP_BYTE_LIMIT } from './session-recap.js';

function fixture(text = 'Explicit fixture evidence'): SessionRecap {
  const repositoryId = '22222222-2222-4222-8222-222222222222';
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const steps = Array.from({ length: 40 }, (_item, index) => ({
    sequence: index < 20 ? index + 1 : index + 86,
    eventId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    command: text,
    outcome: 'Exited with code 1',
    outputExcerpt: text,
    diffSummary: text,
  }));
  return {
    session: {
      id: sessionId,
      repositoryId,
      title: 'Explicit recap budget fixture',
      status: 'open',
      createdAt: '2026-10-21T09:00:00.000Z',
      closedAt: null,
      eventCount: 125,
      memoryCount: 0,
    },
    generatedAt: '2026-10-21T10:00:00.000Z',
    mode: 'observed',
    label: 'Observed investigation recap — deterministic, not AI-generated',
    summary: text,
    coverage: {
      totalEvents: 125,
      includedEvents: 40,
      omittedEvents: 85,
      eventLimit: 40,
      selection: 'first_and_last',
    },
    counts: {
      passed: 0,
      failed: 40,
      interrupted: 0,
      spawnFailed: 0,
      incomplete: 0,
      withDiffs: 40,
      incompleteCapture: 40,
    },
    steps,
    sources: steps.map((step) => ({
      id: step.eventId,
      kind: 'event',
      repositoryId,
      locator: `/v1/events/${step.eventId}`,
    })),
    uncertainty: ['Fixture uncertainty: omitted middle events may change the interpretation.'],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('MCP investigation recap boundary and aggregate response budget', () => {
  it('keeps ordinary observed evidence unchanged and denies unexpected API shapes', async () => {
    const input = fixture();
    expect(Check(SessionRecapSchema, input)).toBe(true);
    const result = buildSessionRecapResult(input);
    expect(result.excerpted).toBe(false);
    expect(result.steps).toEqual(input.steps);
    expect(result.uncertainty).toEqual(input.uncertainty);
    expect(result.sources).toEqual(input.sources);
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'private-local-recap-test-token-at-least-32-characters');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...input, mode: 'ai' }))),
    );
    const denied = await toolResult(() =>
      request(`/v1/sessions/${input.session.id}/recap`, SessionRecapSchema),
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('shared runtime contract');
    expect(JSON.stringify(denied)).not.toContain(input.steps[0]!.eventId);
  });

  it.each(['\u0000', '\\"', '界😀'])(
    'retains every citation, step and coverage field for maximally sized %j strings',
    async (character) => {
      const input = fixture();
      const sized = (limit: number) =>
        character
          .repeat(limit)
          .slice(0, limit)
          .replace(/[\uD800-\uDBFF]$/u, '');
      input.session.title = sized(200);
      input.summary = sized(1000);
      input.uncertainty = Array.from({ length: 8 }, () => sized(500));
      input.steps = input.steps.map((step) => ({
        ...step,
        command: sized(300),
        outcome: sized(160),
        outputExcerpt: sized(600),
        diffSummary: sized(300),
      }));
      // Citation metadata is not shortened, even when its optional text is expensive to escape.
      input.sources = input.sources.map((source) => ({ ...source, locator: sized(128) }));
      expect(Check(SessionRecapSchema, input)).toBe(true);
      const result = buildSessionRecapResult(input);
      const response = await toolResult(async () => result);
      expect(response.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(
        SESSION_RECAP_BYTE_LIMIT,
      );
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(128 * 1024);
      expect(result.coverage).toEqual(input.coverage);
      expect(result.counts).toEqual(input.counts);
      expect(result.sources).toEqual(input.sources);
      expect(result.steps.map((step) => [step.sequence, step.eventId])).toEqual(
        input.steps.map((step) => [step.sequence, step.eventId]),
      );
      expect(result.session).toEqual({ ...input.session, title: result.session.title });
      expect(result.generatedAt).toBe(input.generatedAt);
      expect(result.mode).toBe('observed');
      expect(result.label).toBe(input.label);
      expect(result.uncertainty).toHaveLength(8);
      expect(result.evidenceNotice).toContain('Counts describe included events only');
      expect(result.evidenceNotice).toContain('readable text may be shortened');
      expect(JSON.stringify(result)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i);
      expect(buildSessionRecapResult(input)).toEqual(result);
      expect(input.steps[0]!.outputExcerpt).toBe(sized(600));
    },
  );

  it('rejects contradictory citation membership instead of silently rewriting provenance', () => {
    const input = fixture();
    input.sources[0]!.id = '44444444-4444-4444-8444-444444444444';
    expect(() => buildSessionRecapResult(input)).toThrow('citations or coverage');
    const duplicated = fixture();
    duplicated.steps[1]!.eventId = duplicated.steps[0]!.eventId;
    expect(() => buildSessionRecapResult(duplicated)).toThrow('citations or coverage');
  });
});
