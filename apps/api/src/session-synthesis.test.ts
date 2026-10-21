import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';
import {
  SessionSynthesisHistorySchema,
  SessionSynthesisPreviewSchema,
  SessionSynthesisResponseSchema,
} from '@memvora/contracts';
import type {
  CapturedEvent,
  SessionSynthesisHistory,
  SessionSynthesisAnalysis,
  SessionSynthesisInput,
  SessionSynthesisPreview,
  SessionSynthesisResponse,
} from '@memvora/contracts';
import { deriveObservedMemory, LocalMemvora, runSessionSynthesisOnce } from '@memvora/core';
import type { EvidenceEnricher, SessionSynthesizer } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'synthesis-api-private-fixture-token-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
const configuration = {
  provider: 'loopback-fixture',
  model: 'fixture-model',
  fingerprint: 'a'.repeat(64),
  promptVersion: 'session-analysis-v1' as const,
};
const apps: ReturnType<typeof buildApp>[] = [];
const releaseProviders: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseProviders.splice(0)) release();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function generated(input: SessionSynthesisInput): SessionSynthesisAnalysis {
  return {
    overview: {
      text: 'Synthetic interpretation of the recorded attempts; causality is unverified.',
      sourceIds: input.events.slice(0, 2).map((event) => event.id),
    },
    hypotheses: [],
    unresolvedQuestions: [],
    suggestedChecks: [],
    uncertainty: ['The provider fixture is not a real model and does not verify a fix.'],
  };
}
function fixture({
  configured = true,
  embeddedWorker = false,
  count = 2,
  enricher,
}: {
  configured?: boolean;
  embeddedWorker?: boolean;
  count?: number;
  enricher?: EvidenceEnricher;
} = {}) {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Synthetic synthesis API evidence' });
  const session = store.createSession(service.context(), {
    repositoryId: repository.id,
    title: 'Synthetic investigation',
  });
  const events: CapturedEvent[] = Array.from({ length: count }, (_unused, index) => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: index + 1,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: {
      executable: 'fixture-not-executed',
      args: ['check.cjs'],
      shell: 'synthetic_metadata',
    },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: index ? 0 : 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      { ordinal: 0, stream: 'stderr', text: 'SyntheticSessionFailure: recorded test observation.' },
    ],
    diffs: [],
  }));
  if (events.length) service.ingest(events);
  const synthesize = vi.fn(async (input: SessionSynthesisInput) => generated(input));
  const synthesis: SessionSynthesizer = { configuration, synthesize };
  const app = buildApp({
    store,
    token,
    embeddedWorker,
    ...(configured ? { synthesis } : {}),
    ...(enricher ? { enricher } : {}),
  });
  apps.push(app);
  const path = `/v1/sessions/${session.id}/synthesis`;
  const preview = async () => {
    const result = await app.inject({ method: 'GET', url: `${path}/preview`, headers });
    expect(result.statusCode).toBe(200);
    const value = result.json<SessionSynthesisPreview>();
    expect(Check(SessionSynthesisPreviewSchema, value)).toBe(true);
    return value;
  };
  const request = (payload: unknown) => app.inject({ method: 'POST', url: path, headers, payload });
  const status = async (requestId?: string) => {
    const result = await app.inject({
      method: 'GET',
      url: `${path}${requestId ? `?requestId=${requestId}` : ''}`,
      headers,
    });
    expect(result.statusCode).toBe(200);
    const value = result.json<SessionSynthesisResponse>();
    expect(Check(SessionSynthesisResponseSchema, value)).toBe(true);
    return value;
  };
  return {
    app,
    store,
    service,
    repository,
    session,
    events,
    path,
    synthesis,
    synthesize,
    preview,
    request,
    status,
  };
}

describe('explicit local session synthesis HTTP lifecycle', () => {
  it('authenticates metadata history and rejects queries and malformed session selectors without writes', async () => {
    const f = fixture();
    const path = `${f.path}/history`;
    const before = f.store.database.prepare('SELECT total_changes() AS count').get()!.count;
    expect((await f.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: path,
          headers: { ...headers, host: 'untrusted.example' },
        })
      ).statusCode,
    ).toBe(403);
    for (const suffix of ['?limit=1', `?requestId=${randomUUID()}`, '?unknown=1'])
      expect(
        (await f.app.inject({ method: 'GET', url: `${path}${suffix}`, headers })).statusCode,
      ).toBe(400);
    for (const id of ['not-a-uuid', randomUUID()])
      expect(
        (
          await f.app.inject({
            method: 'GET',
            url: `/v1/sessions/${id}/synthesis/history`,
            headers,
          })
        ).statusCode,
      ).toBe(id === 'not-a-uuid' ? 400 : 404);
    const response = await f.app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      sessionId: f.session.id,
      repositoryId: f.repository.id,
      items: [],
      retainedCount: 0,
      requestLimit: 32,
      analysisIncluded: false,
      sourcesIncluded: false,
    });
    expect(f.store.database.prepare('SELECT total_changes() AS count').get()!.count).toBe(before);
    expect(f.synthesize).not.toHaveBeenCalled();
  });

  it('discovers earlier ready versions after a later failure without exposing analysis or source payloads', async () => {
    const f = fixture();
    const preview = await f.preview();
    const requestIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const requestId = randomUUID();
      requestIds.push(requestId);
      expect(
        (await f.request({ requestId, expectedInputHash: preview.inputHash })).statusCode,
      ).toBe(202);
      if (index < 2) expect(await runSessionSynthesisOnce(f.store, f.synthesis)).toBe(true);
      else {
        const job = f.store.claimSessionSynthesis(configuration);
        expect(job).not.toBeNull();
        f.store.failSessionSynthesis(job!);
      }
    }
    const before = f.store.database.prepare('SELECT total_changes() AS count').get()!.count;
    const response = await f.app.inject({ method: 'GET', url: `${f.path}/history`, headers });
    expect(response.statusCode).toBe(200);
    const history = response.json<SessionSynthesisHistory>();
    expect(Check(SessionSynthesisHistorySchema, history)).toBe(true);
    expect(history.items.map((item) => item.id)).toEqual([...requestIds].reverse());
    expect(history.items.map((item) => item.status)).toEqual(['failed', 'ready', 'ready']);
    expect(history.retainedCount).toBe(3);
    expect(history.order).toBe('newest_requested_first');
    for (const item of history.items) {
      const detail = (await f.status(item.id)).request!;
      const { analysis: _analysis, sources: _sources, ...metadata } = detail;
      expect(item).toEqual(metadata);
      expect(item).not.toHaveProperty('analysis');
      expect(item).not.toHaveProperty('sources');
      expect(item).not.toHaveProperty('input');
    }
    expect(response.body).not.toContain('Synthetic interpretation of the recorded attempts');
    expect((await f.status(requestIds[0])).request?.status).toBe('ready');
    expect(f.store.database.prepare('SELECT total_changes() AS count').get()!.count).toBe(before);
    expect(f.synthesize).toHaveBeenCalledTimes(2);
  });

  it('keeps retained history readable when synthesis is disabled and denies unavailable repository scope', async () => {
    const f = fixture({ configured: false });
    const context = f.service.context();
    const preview = f.store.getSessionSynthesisPreview(context, f.session.id, configuration);
    const saved = f.store.requestSessionSynthesis(
      context,
      f.session.id,
      { requestId: randomUUID(), expectedInputHash: preview.inputHash! },
      configuration,
    );
    const other = f.store.createSession(context, { repositoryId: f.repository.id });
    const before = f.store.database.prepare('SELECT total_changes() AS count').get()!.count;
    const result = await f.app.inject({ method: 'GET', url: `${f.path}/history`, headers });
    expect(result.statusCode).toBe(200);
    const history = result.json<SessionSynthesisHistory>();
    expect(Check(SessionSynthesisHistorySchema, history)).toBe(true);
    expect(history.configuration).toBeNull();
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ id: saved.request.id, status: 'queued', stale: true });
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `/v1/sessions/${other.id}/synthesis/history`,
          headers,
        })
      ).json<SessionSynthesisHistory>().items,
    ).toEqual([]);
    expect(f.store.database.prepare('SELECT total_changes() AS count').get()!.count).toBe(before);
    f.store.deleteRepository(context, f.repository.id);
    expect(
      (await f.app.inject({ method: 'GET', url: `${f.path}/history`, headers })).statusCode,
    ).toBe(404);
    expect(f.synthesize).not.toHaveBeenCalled();
  });

  it('authenticates every route and rejects malformed selectors/extra fields before scheduling', async () => {
    const f = fixture();
    for (const path of [f.path, `${f.path}/preview`]) {
      expect((await f.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
      expect(
        (
          await f.app.inject({
            method: 'GET',
            url: path,
            headers: { ...headers, host: 'attacker.example' },
          })
        ).statusCode,
      ).toBe(403);
    }
    for (const suffix of ['?requestId=not-a-uuid', '?unknown=1'])
      expect(
        (await f.app.inject({ method: 'GET', url: `${f.path}${suffix}`, headers })).statusCode,
      ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `${f.path}/preview?requestId=${randomUUID()}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const input = { requestId: randomUUID(), expectedInputHash: 'a'.repeat(64) };
    expect((await f.app.inject({ method: 'POST', url: f.path, payload: input })).statusCode).toBe(
      401,
    );
    expect((await f.request({ ...input, workspaceId: randomUUID() })).statusCode).toBe(400);
    expect(
      (await f.app.inject({ method: 'POST', url: `${f.path}?unknown=1`, headers, payload: input }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `/v1/sessions/${randomUUID()}/synthesis`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect((await f.status()).request).toBeNull();
    expect(f.synthesize).not.toHaveBeenCalled();
  });

  it('reports disabled or insufficient evidence without manufacturing a request or calling the provider', async () => {
    const disabled = fixture({ configured: false });
    expect((await disabled.preview()).availability).toBe('disabled');
    expect(
      (await disabled.request({ requestId: randomUUID(), expectedInputHash: 'a'.repeat(64) }))
        .statusCode,
    ).toBe(503);
    expect((await disabled.status()).request).toBeNull();
    const empty = fixture({ count: 0 });
    expect((await empty.preview()).availability).toBe('insufficient_evidence');
    expect(
      (await empty.request({ requestId: randomUUID(), expectedInputHash: 'a'.repeat(64) }))
        .statusCode,
    ).toBe(422);
    expect((await empty.status()).request).toBeNull();
    expect(disabled.synthesize).not.toHaveBeenCalled();
    expect(empty.synthesize).not.toHaveBeenCalled();
  });

  it('returns202 once/200 replay, keeps reads read-only and spends only on an explicit processing claim', async () => {
    const f = fixture();
    const preview = await f.preview();
    expect(preview.availability).toBe('available');
    const input = { requestId: randomUUID(), expectedInputHash: preview.inputHash };
    const created = await f.request(input);
    expect(created.statusCode).toBe(202);
    expect(created.json<SessionSynthesisResponse>().request).toMatchObject({
      id: input.requestId,
      status: 'queued',
      attempts: 0,
      analysis: null,
    });
    expect((await f.request(input)).statusCode).toBe(200);
    expect((await f.request({ ...input, expectedInputHash: 'b'.repeat(64) })).statusCode).toBe(409);
    const changes = f.store.database.prepare('SELECT total_changes() AS count').get()!.count;
    await f.preview();
    await f.status();
    await f.status(input.requestId);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/ask',
          headers,
          payload: { query: 'SyntheticSessionFailure', repositoryIds: [f.repository.id] },
        })
      ).statusCode,
    ).toBe(200);
    expect(f.store.database.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
    expect(f.synthesize).not.toHaveBeenCalled();
    expect(await runSessionSynthesisOnce(f.store, f.synthesis)).toBe(true);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    const ready = await f.status(input.requestId);
    expect(ready.request).toMatchObject({
      id: input.requestId,
      status: 'ready',
      attempts: 1,
      failureCode: null,
    });
    expect(ready.request!.analysis!.overview.sourceIds).toEqual(
      f.events.map((event) => event.eventId),
    );
    expect(ready.request!.sources.map((source) => source.id)).toEqual(
      f.events.map((event) => event.eventId),
    );
    expect(await runSessionSynthesisOnce(f.store, f.synthesis)).toBe(false);
    expect((await f.request(input)).statusCode).toBe(200);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(
      f.store
        .jobs(f.service.context(), { sessionId: f.session.id })
        .every((job) => job.status === 'queued'),
    ).toBe(true);
    const other = f.store.createSession(f.service.context(), { repositoryId: f.repository.id });
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `/v1/sessions/${other.id}/synthesis?requestId=${input.requestId}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('retains one failed attempt safely and requires a new explicit request before another provider call', async () => {
    const f = fixture();
    f.synthesize.mockRejectedValue(new Error('PrivateProviderResponseMustNeverBePersisted'));
    const preview = await f.preview();
    const input = { requestId: randomUUID(), expectedInputHash: preview.inputHash };
    expect((await f.request(input)).statusCode).toBe(202);
    expect(await runSessionSynthesisOnce(f.store, f.synthesis)).toBe(true);
    expect((await f.status()).request).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureCode: 'PROVIDER_FAILED',
      analysis: null,
    });
    expect(JSON.stringify(await f.status())).not.toContain(
      'PrivateProviderResponseMustNeverBePersisted',
    );
    expect(await runSessionSynthesisOnce(f.store, f.synthesis)).toBe(false);
    expect((await f.request(input)).statusCode).toBe(200);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect((await f.request({ ...input, requestId: randomUUID() })).statusCode).toBe(202);
    await runSessionSynthesisOnce(f.store, f.synthesis);
    expect(f.synthesize).toHaveBeenCalledTimes(2);
    await f.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${f.session.id}`,
      headers,
      payload: { confirm: true },
    });
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `${f.path}?requestId=${input.requestId}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('serializes an active synthesis against event enrichment and gives both queues processing turns', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    releaseProviders.push(release);
    const eventEnricher = vi.fn(async (event: CapturedEvent) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return deriveObservedMemory(event);
      } finally {
        active--;
      }
    });
    const f = fixture({ embeddedWorker: true, enricher: eventEnricher });
    f.synthesize.mockImplementation(async (input) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await gate;
        return generated(input);
      } finally {
        active--;
      }
    });
    const preview = await f.preview();
    expect(
      (await f.request({ requestId: randomUUID(), expectedInputHash: preview.inputHash }))
        .statusCode,
    ).toBe(202);
    await vi.advanceTimersByTimeAsync(750);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(eventEnricher).not.toHaveBeenCalled();
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(750);
    expect(eventEnricher).toHaveBeenCalledTimes(1);
    expect(maximum).toBe(1);
    expect((await f.status()).request!.status).toBe('ready');
  });
});
