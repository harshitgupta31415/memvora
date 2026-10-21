import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSynthesisPreview, SessionSynthesisResponse } from '@memvora/contracts';
import {
  prepareSynthesisRequest,
  readSessionSynthesis,
  readSynthesisPreview,
  submitSessionSynthesis,
} from './session-synthesis.js';

const sessionId = '11000000-0000-4000-8000-000000000001';
const requestId = '11000000-0000-4000-8000-000000000002';
const repositoryId = '11000000-0000-4000-8000-000000000003';
const events = ['11000000-0000-4000-8000-000000000004', '11000000-0000-4000-8000-000000000005'];
const hash = 'a'.repeat(64);
const token = 'synthetic-session-synthesis-test-token-at-least-32-characters';
const configuration = {
  provider: 'Synthetic test provider',
  model: 'synthetic-model',
  fingerprint: 'b'.repeat(64),
  promptVersion: 'session-analysis-v1' as const,
};
const coverage = {
  totalEvents: 2,
  includedEvents: 2,
  omittedEvents: 0,
  totalNotes: 0,
  includedNotes: 0,
  omittedNotes: 0,
  excerptLimit: 1200,
  inputByteLimit: 65536 as const,
  repositoryFilesIncluded: false as const,
  derivedMemoriesIncluded: false as const,
};
function response(): SessionSynthesisResponse {
  return {
    sessionId,
    configuration,
    request: {
      id: requestId,
      sessionId,
      repositoryId,
      status: 'queued',
      attempts: 0,
      createdAt: '2026-10-21T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      inputHash: hash,
      configuration,
      coverage,
      sources: events.map((id) => ({
        id,
        kind: 'event',
        repositoryId,
        locator: `/v1/events/${id}`,
      })),
      stale: false,
      failureCode: null,
      analysis: null,
    },
  };
}
function preview(): SessionSynthesisPreview {
  return {
    sessionId,
    repositoryId,
    availability: 'available',
    configuration,
    inputHash: hash,
    inputBytes: 1600,
    coverage,
    sourceIds: events,
    notices: ['Synthetic fixture; no provider invoked.'],
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('CLI explicit session synthesis', () => {
  it('generates one identity and preserves an explicitly supplied retry identity', () => {
    const generate = vi.fn(() => requestId);
    expect(prepareSynthesisRequest(hash, undefined, generate)).toEqual({
      requestId,
      expectedInputHash: hash,
    });
    expect(prepareSynthesisRequest(hash, requestId, generate)).toEqual({
      requestId,
      expectedInputHash: hash,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    for (const value of ['', 'A'.repeat(64), '../private', 'a'.repeat(65)])
      expect(() => prepareSynthesisRequest(value, requestId)).toThrow('input hash');
    expect(() => prepareSynthesisRequest(hash, '../private')).toThrow('UUID');
  });

  it('uses only GET for preview and status, pins requested IDs and rejects invalid scope before access', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview())))
      .mockResolvedValueOnce(new Response(JSON.stringify(response())));
    vi.stubGlobal('fetch', fetcher);
    await expect(readSynthesisPreview('http://127.0.0.1:4000', token, sessionId)).resolves.toEqual(
      preview(),
    );
    await expect(
      readSessionSynthesis('http://127.0.0.1:4000', token, sessionId, requestId),
    ).resolves.toEqual(response());
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/sessions/${sessionId}/synthesis/preview`,
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(`synthesis?requestId=${requestId}`);
    for (const [, options] of fetcher.mock.calls)
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    await expect(
      readSessionSynthesis('http://127.0.0.1:4000', token, sessionId, '../other'),
    ).rejects.toThrow('UUID');
    await expect(readSynthesisPreview('http://127.0.0.1:4000', token, '../other')).rejects.toThrow(
      'UUID',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ ...response(), sessionId: requestId })),
    );
    await expect(readSessionSynthesis('http://127.0.0.1:4000', token, sessionId)).rejects.toThrow(
      'authorized evidence',
    );
  });

  it('reports only stable retry fields after an uncertain write and resends the exact explicit request', async () => {
    const input = prepareSynthesisRequest(hash, requestId);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: `Private remote detail ${token}` } }), {
          status: 503,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(response()), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const failure = await submitSessionSynthesis(
      'http://127.0.0.1:4000',
      token,
      sessionId,
      input,
    ).catch((error: Error) => error);
    expect(String(failure)).toContain(`--request-id ${requestId}`);
    expect(String(failure)).toContain(`--input-hash ${hash}`);
    expect(String(failure)).not.toContain(token);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      submitSessionSynthesis('http://127.0.0.1:4000', token, sessionId, input),
    ).resolves.toEqual(response());
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toBe(`http://127.0.0.1:4000/v1/sessions/${sessionId}/synthesis`);
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(JSON.parse(String(options?.body))).toEqual(input);
    }
  });

  it('never accepts a successful HTTP response for a different request or input hash', async () => {
    const input = prepareSynthesisRequest(hash, requestId);
    const value = response();
    value.request!.inputHash = 'c'.repeat(64);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value)));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      submitSessionSynthesis('http://127.0.0.1:4000', token, sessionId, input),
    ).rejects.toThrow(`--request-id ${requestId}`);
    value.request!.inputHash = hash;
    value.request!.id = events[0]!;
    await expect(
      submitSessionSynthesis('http://127.0.0.1:4000', token, sessionId, input),
    ).rejects.toThrow(`--request-id ${requestId}`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
