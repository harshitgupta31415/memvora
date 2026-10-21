import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  CapturedEvent,
  SessionNote,
  SessionSynthesisAnalysis,
  SessionSynthesisConfiguration,
  SessionSynthesisHistory,
  SessionSynthesisResponse,
} from '@memvora/contracts';
import type { SessionHandoverEvidence } from './local-service.js';
import type { SessionSynthesisJob, SessionSynthesisStore } from './session-synthesis-types.js';
import {
  buildSessionSynthesisInput,
  runSessionSynthesisOnce,
  sessionSynthesisInputHash,
  validateSessionSynthesisAnalysis,
  validateSessionSynthesisHistory,
  validateSessionSynthesisPreview,
  validateSessionSynthesisResponse,
} from './session-synthesis.js';

const configuration: SessionSynthesisConfiguration = {
  provider: 'synthetic-fixture',
  model: 'synthetic-model',
  fingerprint: 'a'.repeat(64),
  promptVersion: 'session-analysis-v1',
};
const time = '2026-10-21T00:00:00.000Z';
function fixture(count = 3) {
  const repository = {
    id: randomUUID(),
    workspaceId: randomUUID(),
    name: 'Synthetic evidence',
    localPath: 'private-registration-path',
    remoteUrl: null,
    status: 'active' as const,
    createdAt: time,
  };
  const session = {
    id: randomUUID(),
    repositoryId: repository.id,
    title: 'Synthetic port investigation',
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
    command: { executable: 'synthetic-observation', args: ['check'], shell: 'direct' },
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
    body: 'My conclusion remains an author claim.',
    author: { id: randomUUID(), name: 'Test author' },
    createdAt: time,
    label: 'User-authored — not independently verified',
    sources: events.slice(0, 1).map((event) => ({
      id: event.eventId,
      repositoryId: repository.id,
      kind: 'event',
      locator: `/v1/events/${event.eventId}`,
    })),
  };
  const selected = count <= 40 ? events : [...events.slice(0, 20), ...events.slice(-20)];
  const evidence: SessionHandoverEvidence = {
    repository,
    recapEvidence: { session, events: selected, totalEventCount: count },
    events: selected,
    notes: [note],
    totalEventCount: count,
    totalNoteCount: 1,
  };
  return { evidence, events, note, session, repository };
}
function analysis(id: string): SessionSynthesisAnalysis {
  return {
    overview: {
      text: 'A failed observation was followed by successful observations.',
      sourceIds: [id],
    },
    hypotheses: [],
    unresolvedQuestions: [],
    suggestedChecks: [],
    uncertainty: ['A passing exit does not prove the cause or a verified resolution.'],
  };
}
function ready() {
  const f = fixture();
  const { input, sources } = buildSessionSynthesisInput(f.evidence);
  const response: SessionSynthesisResponse = {
    sessionId: f.session.id,
    configuration,
    request: {
      id: randomUUID(),
      sessionId: f.session.id,
      repositoryId: f.repository.id,
      status: 'ready',
      attempts: 1,
      createdAt: time,
      startedAt: time,
      finishedAt: time,
      inputHash: sessionSynthesisInputHash(input, configuration, 'revision-1'),
      configuration,
      coverage: input.coverage,
      sources,
      stale: false,
      failureCode: null,
      analysis: analysis(f.events[0]!.eventId),
    },
  };
  return { ...f, input, response };
}
function history() {
  const f = ready();
  const item = { ...f.response.request! };
  Reflect.deleteProperty(item, 'analysis');
  Reflect.deleteProperty(item, 'sources');
  const value: SessionSynthesisHistory = {
    sessionId: f.session.id,
    repositoryId: f.repository.id,
    configuration,
    items: [item],
    retainedCount: 1,
    requestLimit: 32,
    order: 'newest_requested_first',
    analysisIncluded: false,
    sourcesIncluded: false,
  };
  return { ...f, value };
}

describe('bounded explicit investigation interpretation', () => {
  it('projects original observations and author claims without registration metadata or mutation', () => {
    const f = fixture();
    const event = f.events[0]!;
    event.output = [
      { stream: 'stderr', ordinal: 0, text: 'pass\u001b[31mword=' },
      { stream: 'stderr', ordinal: 1, text: 'private-value\r\nSynthetic failure' },
    ];
    event.diffs = [{ phase: 'after', text: 'to\u202eken=hidden-value', truncatedBytes: 7 }];
    const before = JSON.stringify(f.evidence);
    const { input, sources } = buildSessionSynthesisInput(f.evidence);
    expect(input.events[0]).toMatchObject({
      id: event.eventId,
      sequence: 1,
      outcome: { exitCode: 1 },
      captureIncomplete: true,
    });
    expect(input.events[0]!.output).toContain('password=[REDACTED]');
    expect(input.notes[0]).toMatchObject({ kind: 'resolution', eventIds: [event.eventId] });
    expect(sources.map((source) => source.id)).toEqual([
      ...f.events.map((item) => item.eventId),
      f.note.id,
    ]);
    expect(JSON.stringify(input)).not.toMatch(
      /private-value|hidden-value|private-registration-path|workspaceId|\\u001b|\\u202e/u,
    );
    expect(JSON.stringify(f.evidence)).toBe(before);
  });

  it('keeps 140 event identities and ten note source sets while reducing worst-case UTF-8 input to 64 KiB', () => {
    const f = fixture(140);
    const middle = f.events.slice(20, 120);
    f.evidence.notes = Array.from({ length: 10 }, (_, index) => ({
      ...f.note,
      id: randomUUID(),
      body: '😀界'.repeat(2000),
      sources: middle.slice(index * 10, index * 10 + 10).map((event) => ({
        id: event.eventId,
        repositoryId: event.repositoryId,
        kind: 'event' as const,
        locator: `/v1/events/${event.eventId}`,
      })),
    }));
    f.evidence.events = f.events;
    f.evidence.totalNoteCount = 30;
    for (const event of f.events) {
      event.output = [{ stream: 'stdout', ordinal: 0, text: '😀界'.repeat(3000) }];
      event.diffs = [{ phase: 'after', text: '😀界'.repeat(3000), truncatedBytes: 0 }];
    }
    const { input, sources } = buildSessionSynthesisInput(f.evidence);
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThanOrEqual(65_536);
    expect(input.coverage).toMatchObject({
      includedEvents: 140,
      includedNotes: 10,
      omittedNotes: 20,
    });
    expect(input.coverage.excerptLimit).toBeLessThan(1200);
    expect(input.events.map((event) => event.id)).toEqual(f.events.map((event) => event.eventId));
    expect(input.notes.map((note) => note.eventIds)).toEqual(
      f.evidence.notes.map((note) => note.sources.map((source) => source.id)),
    );
    expect(sources).toHaveLength(150);
    for (const item of input.events) {
      expect(item.output).not.toMatch(/[\uD800-\uDBFF]…$/u);
      expect(item.excerpted).toBe(true);
    }
  });

  it('pins stable evidence, durable revision and provider configuration independently', () => {
    const { evidence } = fixture();
    const { input } = buildSessionSynthesisInput(evidence);
    const hash = sessionSynthesisInputHash(input, configuration, 'intake:5,note:2');
    expect(
      sessionSynthesisInputHash(structuredClone(input), { ...configuration }, 'intake:5,note:2'),
    ).toBe(hash);
    expect(
      sessionSynthesisInputHash(
        input,
        {
          promptVersion: configuration.promptVersion,
          fingerprint: configuration.fingerprint,
          model: configuration.model,
          provider: configuration.provider,
        },
        'intake:5,note:2',
      ),
    ).toBe(hash);
    expect(sessionSynthesisInputHash(input, configuration, 'intake:6,note:2')).not.toBe(hash);
    expect(
      sessionSynthesisInputHash(
        input,
        { ...configuration, fingerprint: 'b'.repeat(64) },
        'intake:5,note:2',
      ),
    ).not.toBe(hash);
    input.events[0]!.output = 'Changed observation';
    expect(sessionSynthesisInputHash(input, configuration, 'intake:5,note:2')).not.toBe(hash);
  });

  it('preserves a spawn error or termination signal even when no output was captured', () => {
    const { evidence, events } = fixture();
    events[0]!.outcome = {
      kind: 'spawn_failed',
      exitCode: null,
      signal: null,
      error: { code: 'ENOENT', message: 'Missing executable; password=private-value' },
    };
    events[1]!.outcome = { kind: 'interrupted', exitCode: null, signal: 'SIGTERM' };
    const { input } = buildSessionSynthesisInput(evidence);
    expect(input.events[0]!.output).toContain(
      '[process error ENOENT] Missing executable; password=[REDACTED]',
    );
    expect(input.events[1]!.output).toContain('[signal SIGTERM]');
    expect(JSON.stringify(input)).not.toContain('private-value');
  });

  it('rejects uncited, foreign, duplicate and oversized model claims and normalizes before redaction', () => {
    const { evidence } = fixture();
    const { input } = buildSessionSynthesisInput(evidence);
    const valid = analysis(input.events[0]!.id);
    valid.overview.text = 'pass\u001b[31mword=private-value';
    expect(validateSessionSynthesisAnalysis(valid, input).overview.text).toBe(
      'password=[REDACTED]',
    );
    const foreign = { ...valid, overview: { ...valid.overview, sourceIds: [randomUUID()] } };
    expect(() => validateSessionSynthesisAnalysis(foreign, input)).toThrow('authorized evidence');
    expect(() =>
      validateSessionSynthesisAnalysis(
        { ...valid, overview: { text: 'Unsupported', sourceIds: [] } },
        input,
      ),
    ).toThrow();
    valid.overview.sourceIds.push(valid.overview.sourceIds[0]!);
    expect(() => validateSessionSynthesisAnalysis(valid, input)).toThrow();
    const huge = analysis(input.events[0]!.id);
    huge.hypotheses = Array.from({ length: 6 }, () => ({
      text: '界'.repeat(1200),
      sourceIds: [input.events[0]!.id],
    }));
    huge.suggestedChecks = structuredClone(huge.hypotheses);
    expect(() => validateSessionSynthesisAnalysis(huge, input)).toThrow();
  });

  it('rejects cross-session, corrupt citation, inconsistent coverage and unpublished result states', () => {
    const { response, session } = ready();
    expect(validateSessionSynthesisResponse(response, session.id, response.request!.id)).toBe(
      response,
    );
    expect(() => validateSessionSynthesisResponse(response, randomUUID())).toThrow();
    expect(() => validateSessionSynthesisResponse(response, session.id, randomUUID())).toThrow();
    for (const corrupt of [
      (value: SessionSynthesisResponse) => {
        value.request!.sources[0]!.repositoryId = randomUUID();
      },
      (value: SessionSynthesisResponse) => {
        value.request!.sources[0]!.locator = 'https://external.invalid';
      },
      (value: SessionSynthesisResponse) => {
        value.request!.coverage.omittedEvents++;
      },
      (value: SessionSynthesisResponse) => {
        value.request!.status = 'running';
      },
      (value: SessionSynthesisResponse) => {
        value.configuration = null;
      },
    ]) {
      const value = structuredClone(response);
      corrupt(value);
      expect(() => validateSessionSynthesisResponse(value, session.id)).toThrow();
    }
    const stale = structuredClone(response);
    stale.configuration = null;
    stale.request!.stale = true;
    expect(validateSessionSynthesisResponse(stale, session.id).request!.status).toBe('ready');
    const absent = { ...response, request: null };
    expect(validateSessionSynthesisResponse(absent, session.id).request).toBeNull();
    expect(() => validateSessionSynthesisResponse(absent, session.id, randomUUID())).toThrow();
  });

  it('validates preview availability against counts and does not accept duplicate source identities', () => {
    const { input, response, session, repository } = ready();
    const preview = {
      sessionId: session.id,
      repositoryId: repository.id,
      availability: 'available' as const,
      configuration,
      inputHash: response.request!.inputHash,
      inputBytes: Buffer.byteLength(JSON.stringify(input)),
      coverage: input.coverage,
      sourceIds: response.request!.sources.map((source) => source.id),
      notices: [],
    };
    expect(validateSessionSynthesisPreview(preview, session.id)).toBe(preview);
    expect(() =>
      validateSessionSynthesisPreview({ ...preview, availability: 'disabled' }, session.id),
    ).toThrow();
    expect(() =>
      validateSessionSynthesisPreview(
        { ...preview, availability: 'insufficient_evidence' },
        session.id,
      ),
    ).toThrow();
    preview.sourceIds[1] = preview.sourceIds[0]!;
    expect(() => validateSessionSynthesisPreview(preview, session.id)).toThrow();
  });

  it('passes a copy to the provider and validates citations against the original claimed input', async () => {
    const { input } = ready();
    const job: SessionSynthesisJob = {
      id: randomUUID(),
      leaseToken: randomUUID(),
      input,
      configuration,
      inputHash: sessionSynthesisInputHash(input, configuration, 'revision'),
    };
    const complete = vi.fn(() => true);
    const fail = vi.fn();
    const store: SessionSynthesisStore = {
      listSessionSyntheses: vi.fn(),
      getSessionSynthesisPreview: vi.fn(),
      requestSessionSynthesis: vi.fn(),
      getSessionSynthesis: vi.fn(),
      claimSessionSynthesis: vi.fn().mockReturnValueOnce(job).mockReturnValue(null),
      completeSessionSynthesis: complete,
      failSessionSynthesis: fail,
    };
    const provider = vi.fn(async (copy: typeof input) => {
      copy.events[0]!.id = randomUUID();
      return analysis(copy.events[0]!.id);
    });
    const originalId = input.events[0]!.id;
    expect(await runSessionSynthesisOnce(store, { configuration, synthesize: provider })).toBe(
      true,
    );
    expect(input.events[0]!.id).toBe(originalId);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledExactlyOnceWith(job);
    expect(await runSessionSynthesisOnce(store, { configuration, synthesize: provider })).toBe(
      false,
    );
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('investigation interpretation history metadata boundary', () => {
  it('preserves server order and all identities without adding result text or citations', () => {
    const { value, session } = history();
    const older = {
      ...value.items[0]!,
      id: randomUUID(),
      status: 'failed' as const,
      failureCode: 'PROVIDER_FAILED' as const,
    };
    value.items.push(older);
    value.retainedCount = 2;
    const before = JSON.stringify(value);
    expect(validateSessionSynthesisHistory(value, session.id)).toBe(value);
    expect(value.items.map((item) => item.id)).toEqual([value.items[0]!.id, older.id]);
    expect(JSON.stringify(value)).toBe(before);
    expect(value.items.every((item) => !('analysis' in item) && !('sources' in item))).toBe(true);
  });

  it('supports empty history and a disabled provider without invalidating retained stale results', () => {
    const { value, session } = history();
    value.configuration = null;
    expect(() => validateSessionSynthesisHistory(value, session.id)).toThrow();
    value.items[0]!.stale = true;
    expect(validateSessionSynthesisHistory(value, session.id).items).toHaveLength(1);
    value.items = [];
    value.retainedCount = 0;
    expect(validateSessionSynthesisHistory(value, session.id).retainedCount).toBe(0);
  });

  it('rejects foreign/duplicate identities, mismatched counts, payload leakage and impossible lifecycle metadata', () => {
    const { value, session } = history();
    const mutations = [
      (page: SessionSynthesisHistory) => {
        page.sessionId = randomUUID();
      },
      (page: SessionSynthesisHistory) => {
        page.items[0]!.sessionId = randomUUID();
      },
      (page: SessionSynthesisHistory) => {
        page.items[0]!.repositoryId = randomUUID();
      },
      (page: SessionSynthesisHistory) => {
        page.retainedCount = 0;
      },
      (page: SessionSynthesisHistory) => {
        page.items.push({ ...page.items[0]! });
        page.retainedCount = 2;
      },
      (page: SessionSynthesisHistory) => {
        page.items[0]!.coverage.omittedEvents++;
      },
      (page: SessionSynthesisHistory) => {
        page.items[0]!.attempts = 0;
      },
      (page: SessionSynthesisHistory) => {
        page.items[0]!.status = 'running';
      },
      (page: SessionSynthesisHistory) => {
        Reflect.set(page.items[0]!, 'analysis', { overview: 'private content' });
      },
      (page: SessionSynthesisHistory) => {
        Reflect.set(page.items[0]!, 'sources', []);
      },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(value);
      mutate(copy);
      expect(() => validateSessionSynthesisHistory(copy, session.id)).toThrow(
        'authorized evidence',
      );
    }
  });

  it('requires stale disclosure for a changed descriptor even when its fingerprint was incorrectly reused', () => {
    const { value, session } = history();
    value.configuration = { ...configuration, model: 'changed-model' };
    expect(() => validateSessionSynthesisHistory(value, session.id)).toThrow();
    value.items[0]!.stale = true;
    expect(validateSessionSynthesisHistory(value, session.id).items[0]!.configuration.model).toBe(
      'synthetic-model',
    );
  });

  it('retains all 32 long-model metadata records within budget and rejects excess membership', () => {
    const { value, session } = history();
    value.configuration = { ...configuration, provider: 'x'.repeat(200), model: '界'.repeat(200) };
    value.items = Array.from({ length: 32 }, () => ({
      ...value.items[0]!,
      id: randomUUID(),
      configuration: value.configuration!,
    }));
    value.retainedCount = 32;
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeLessThanOrEqual(65_536);
    expect(validateSessionSynthesisHistory(value, session.id).items).toHaveLength(32);
    value.items.push({ ...value.items[0]!, id: randomUUID() });
    value.retainedCount++;
    expect(() => validateSessionSynthesisHistory(value, session.id)).toThrow();
  });
});
