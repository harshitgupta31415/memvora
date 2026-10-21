import { describe, expect, it, vi } from 'vitest';
import type { SessionSynthesisPreview } from '@memvora/contracts';
import {
  retainedSynthesisAttempt,
  synthesisRequestQuery,
  synthesisUrlQuery,
} from './session-synthesis';

const requestId = '14000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);
function preview(): SessionSynthesisPreview {
  return {
    sessionId: '14000000-0000-4000-8000-000000000002',
    repositoryId: '14000000-0000-4000-8000-000000000003',
    availability: 'available',
    configuration: {
      provider: 'Synthetic provider',
      model: 'Synthetic model',
      fingerprint: 'b'.repeat(64),
      promptVersion: 'session-analysis-v1',
    },
    inputHash: hash,
    inputBytes: 1200,
    coverage: {
      totalEvents: 2,
      includedEvents: 2,
      omittedEvents: 0,
      totalNotes: 0,
      includedNotes: 0,
      omittedNotes: 0,
      excerptLimit: 1200,
      inputByteLimit: 65536,
      repositoryFilesIncluded: false,
      derivedMemoriesIncluded: false,
    },
    sourceIds: ['14000000-0000-4000-8000-000000000004', '14000000-0000-4000-8000-000000000005'],
    notices: [],
  };
}

describe('explicit web synthesis input and navigation', () => {
  it('rejects duplicate, unknown and malformed query values instead of widening to latest', () => {
    expect(synthesisRequestQuery({})).toEqual({});
    expect(synthesisRequestQuery({ requestId })).toEqual({ requestId });
    for (const input of [
      { requestId: [requestId, requestId] },
      { requestId: '' },
      { requestId: '../other' },
      { repositoryId: requestId },
      { requestId, extra: '' },
    ])
      expect(synthesisRequestQuery(input)).toBeNull();
    expect(
      synthesisUrlQuery(
        `http://127.0.0.1/api/synthesis?requestId=${requestId}&requestId=${requestId}`,
      ),
    ).toBeNull();
    expect(synthesisUrlQuery('http://127.0.0.1/api/synthesis?unknown=1')).toBeNull();
    expect(synthesisUrlQuery(`http://127.0.0.1/api/synthesis?requestId=${requestId}`)).toEqual({
      requestId,
    });
  });

  it('pins the reviewed hash and retains the exact UUID and body through uncertain retries', () => {
    const generate = vi.fn(() => requestId);
    const first = retainedSynthesisAttempt(preview(), null, generate);
    expect(first).toEqual({ requestId, expectedInputHash: hash });
    const changed = { ...preview(), inputHash: 'c'.repeat(64) };
    expect(retainedSynthesisAttempt(changed, first, generate)).toBe(first);
    expect(
      retainedSynthesisAttempt({ ...changed, availability: 'disabled' }, first, generate),
    ).toBe(first);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(retainedSynthesisAttempt(changed, null, generate).expectedInputHash).toBe(
      changed.inputHash,
    );
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not invent a request or hash for unavailable or malformed previews', () => {
    const generate = vi.fn(() => requestId);
    for (const value of [
      { ...preview(), availability: 'disabled' as const },
      { ...preview(), availability: 'insufficient_evidence' as const },
      { ...preview(), configuration: null },
      { ...preview(), inputHash: null },
    ])
      expect(() => retainedSynthesisAttempt(value, null, generate)).toThrow('preview');
    expect(generate).not.toHaveBeenCalled();
  });
});
