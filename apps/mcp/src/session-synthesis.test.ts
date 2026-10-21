import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSynthesisResponseSchema, type SessionSynthesisResponse } from '@memvora/contracts';
import { buildSessionSynthesisResult, SESSION_SYNTHESIS_BYTE_LIMIT } from './session-synthesis.js';
import { request, toolResult } from './client.js';

const sessionId = '12000000-0000-4000-8000-000000000001';
const requestId = '12000000-0000-4000-8000-000000000002';
const repositoryId = '12000000-0000-4000-8000-000000000003';
const id = (number: number) => `13000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
function fixture(text = 'Synthetic model interpretation, not verified.'): SessionSynthesisResponse {
  const configuration = {
    provider: 'Synthetic fixture provider',
    model: 'fixture-model',
    fingerprint: 'b'.repeat(64),
    promptVersion: 'session-analysis-v1' as const,
  };
  const claim = { text, sourceIds: [id(1), id(141)] };
  return {
    sessionId,
    configuration,
    request: {
      id: requestId,
      sessionId,
      repositoryId,
      status: 'ready',
      attempts: 1,
      createdAt: '2026-10-21T10:00:00.000Z',
      startedAt: '2026-10-21T10:00:01.000Z',
      finishedAt: '2026-10-21T10:00:02.000Z',
      inputHash: 'a'.repeat(64),
      configuration,
      coverage: {
        totalEvents: 160,
        includedEvents: 140,
        omittedEvents: 20,
        totalNotes: 15,
        includedNotes: 10,
        omittedNotes: 5,
        excerptLimit: 300,
        inputByteLimit: 65536,
        repositoryFilesIncluded: false,
        derivedMemoriesIncluded: false,
      },
      sources: [
        ...Array.from({ length: 140 }, (_, index) => ({
          id: id(index + 1),
          kind: 'event' as const,
          repositoryId,
          locator: `/v1/events/${id(index + 1)}`,
        })),
        ...Array.from({ length: 10 }, (_, index) => ({
          id: id(index + 141),
          kind: 'session_note' as const,
          repositoryId,
          sessionId,
          locator: `/v1/session-notes/${id(index + 141)}`,
          authorName: 'Synthetic author',
          createdAt: '2026-10-21T10:00:00.000Z',
          noteKind: 'decision' as const,
        })),
      ],
      stale: true,
      failureCode: null,
      analysis: {
        overview: claim,
        hypotheses: Array.from({ length: 6 }, () => claim),
        unresolvedQuestions: Array.from({ length: 6 }, () => claim),
        suggestedChecks: Array.from({ length: 6 }, () => claim),
        uncertainty: ['Incomplete retained evidence and unverified authored claims.'],
      },
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('read-only MCP session synthesis presentation', () => {
  it.each([
    'Explicit synthetic interpretation',
    '\u0000'.repeat(100),
    '\\"'.repeat(150),
    '界😀'.repeat(100),
  ])(
    'preserves complete identity, coverage, citations and claim memberships within escaped budget',
    async (text) => {
      const value = fixture(text);
      const original = structuredClone(value);
      const result = buildSessionSynthesisResult(value, sessionId, requestId);
      const envelope = await toolResult(async () => result);
      expect(envelope.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(
        SESSION_SYNTHESIS_BYTE_LIMIT,
      );
      expect(result.label).toContain('unverified');
      expect(result.readOnly).toBe(true);
      expect(result.request?.stale).toBe(true);
      expect(result.request?.id).toBe(requestId);
      expect(result.request?.inputHash).toBe(value.request?.inputHash);
      expect(result.request?.coverage).toEqual(value.request?.coverage);
      expect(result.request?.configuration).toEqual(value.request?.configuration);
      expect(result.request?.sources).toEqual(value.request?.sources);
      expect(result.request?.analysis?.hypotheses.map((claim) => claim.sourceIds)).toEqual(
        value.request?.analysis?.hypotheses.map((claim) => claim.sourceIds),
      );
      expect(value).toEqual(original);
    },
  );

  it('rejects scope, canonical locator, source closure and processing-state contradictions', () => {
    const outside = fixture();
    outside.sessionId = id(1);
    expect(() => buildSessionSynthesisResult(outside, sessionId)).toThrow('authorized evidence');
    const locator = fixture();
    locator.request!.sources[0]!.locator = 'https://untrusted.invalid/execute';
    expect(() => buildSessionSynthesisResult(locator, sessionId)).toThrow('authorized evidence');
    const orphan = fixture();
    orphan.request!.analysis!.overview.sourceIds = [id(900)];
    expect(() => buildSessionSynthesisResult(orphan, sessionId)).toThrow('authorized evidence');
    const state = fixture();
    state.request!.status = 'queued';
    expect(() => buildSessionSynthesisResult(state, sessionId)).toThrow('authorized evidence');
  });

  it('returns an honest disabled/empty result and reads only GET with no model submission', async () => {
    const value = { sessionId, configuration: null, request: null };
    expect(buildSessionSynthesisResult(value, sessionId).request).toBeNull();
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'synthetic-mcp-synthesis-token-at-least-32-characters');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value)));
    vi.stubGlobal('fetch', fetcher);
    const result = await toolResult(async () =>
      buildSessionSynthesisResult(
        await request<SessionSynthesisResponse>(
          `/v1/sessions/${sessionId}/synthesis`,
          SessionSynthesisResponseSchema,
        ),
        sessionId,
      ),
    );
    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});
