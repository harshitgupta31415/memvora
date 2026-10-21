import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvent, Memory } from '@memvora/contracts';
import { deriveObservedMemory, LocalMemvora } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'private-raw-recall-fixture-token-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const resources: Array<{ app: ReturnType<typeof buildApp>; store: SqliteEvidenceStore }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { app, store } of resources.splice(0)) {
    await app.close();
    store.close();
  }
});

function setup() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Raw evidence fixture' });
  const session = store.createSession(service.context(), { repositoryId: repository.id });
  const provider = vi.fn(async () => {
    throw new Error('Reads must never call a provider.');
  });
  const app = buildApp({ store, token, embeddedWorker: false, enricher: provider });
  resources.push({ app, store });
  const error = `RAW_ERROR_${randomUUID().replaceAll('-', '')}`;
  const secret = 'PrivateRawRecallCredential7611';
  const event: CapturedEvent = {
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: 1,
    startedAt: '2026-10-21T12:00:00.000Z',
    endedAt: '2026-10-21T12:00:01.000Z',
    command: { executable: 'node', args: ['fixture-only-no-command-executed'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      {
        ordinal: 0,
        stream: 'stderr',
        text: `${'Earlier output. '.repeat(200)}\n${error}\npassword=${secret}`,
      },
    ],
    diffs: [],
  };
  return { app, store, service, repository, session, provider, event, error, secret };
}

async function search(app: ReturnType<typeof buildApp>, query: string, repositoryIds?: string[]) {
  return app.inject({
    method: 'POST',
    url: '/v1/memories/search',
    headers,
    payload: { query, ...(repositoryIds === undefined ? {} : { repositoryIds }) },
  });
}

describe('raw evidence recall without enrichment', () => {
  it('finds a queued event outside the displayed excerpt, keeps detail resolvable and prefers its later stored summary', async () => {
    const f = setup();
    const accepted = await f.app.inject({
      method: 'POST',
      url: '/v1/events/batch',
      headers,
      payload: { schemaVersion: 1, events: [f.event] },
    });
    expect(accepted.statusCode).toBe(200);
    const before = f.store.dashboard(f.service.context()).counts;
    expect(before).toMatchObject({ events: 1, memories: 0, queuedJobs: 1 });
    const result = await search(f.app, f.error);
    expect(result.statusCode).toBe(200);
    const raw = result.json<{ items: Memory[] }>().items;
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({
      id: f.event.eventId,
      mode: 'observed',
      representation: 'raw_event',
      processingStatus: 'queued',
    });
    expect(raw[0]!.sources).toEqual([
      {
        id: f.event.eventId,
        repositoryId: f.repository.id,
        kind: 'event',
        locator: `/v1/events/${f.event.eventId}`,
      },
    ]);
    expect(raw[0]!.uncertainty.join(' ')).toContain('not a stored or model-generated summary');
    expect(raw[0]!.summary).not.toContain(f.error);
    expect((await search(f.app, f.secret)).json().items).toEqual([]);
    const detail = await f.app.inject({
      method: 'GET',
      url: `/v1/memories/${f.event.eventId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().memory.representation).toBe('raw_event');
    const original = await f.app.inject({
      method: 'GET',
      url: `/v1/events/${f.event.eventId}`,
      headers,
    });
    expect(original.statusCode).toBe(200);
    expect(original.body).toContain(f.error);
    expect(original.body).not.toContain(f.secret);
    const answer = await f.app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: f.error },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().status).toBe('answered');
    expect(answer.json().sources.map((source: { id: string }) => source.id)).toEqual([
      f.event.eventId,
    ]);
    expect(answer.json().uncertainty.join(' ')).toContain('stored summary is unavailable');
    expect(f.store.dashboard(f.service.context()).counts).toEqual(before);
    expect(f.provider).not.toHaveBeenCalled();

    const job = f.store.claimJob()!;
    expect((await search(f.app, f.error)).json().items[0].processingStatus).toBe('running');
    const summary = {
      ...deriveObservedMemory(job.event),
      title: 'Processed result',
      summary: 'The recorded process exited with code one.',
      steps: [{ text: 'Recorded unsuccessful process outcome.', sourceIds: [f.event.eventId] }],
    };
    expect(f.store.completeJob(job, summary)).toBe(true);
    const completed = (await search(f.app, f.error)).json<{ items: Memory[] }>().items;
    expect(completed).toEqual([summary]);
    expect(
      (
        await f.app.inject({ method: 'GET', url: `/v1/memories/${f.event.eventId}`, headers })
      ).json().memory,
    ).toEqual(summary);
    expect(f.store.dashboard(f.service.context()).counts).toMatchObject({
      events: 1,
      memories: 1,
      queuedJobs: 0,
    });
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('keeps failed-event recall scoped and removes it on parent deletion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = setup();
    f.service.ingest([f.event]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = f.store.claimJob();
      expect(job).not.toBeNull();
      f.store.failJob(job!);
      vi.setSystemTime(new Date(Date.now() + 10_000));
    }
    expect((await search(f.app, f.error)).json().items[0]).toMatchObject({
      representation: 'raw_event',
      processingStatus: 'failed',
    });
    expect(f.store.dashboard(f.service.context()).counts).toMatchObject({
      events: 1,
      memories: 0,
      failedJobs: 1,
    });
    const other = f.service.createRepository({ name: 'Empty isolated repository' });
    expect((await search(f.app, f.error, [other.id])).json().items).toEqual([]);
    expect((await search(f.app, f.error, [])).json().items).toEqual([]);
    expect((await search(f.app, f.error, [randomUUID()])).statusCode).toBe(404);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/memories/search',
          payload: { query: f.error },
        })
      ).statusCode,
    ).toBe(401);
    f.store.deleteSession(f.service.context(), f.session.id);
    expect((await search(f.app, f.error)).json().items).toEqual([]);
    expect(
      (await f.app.inject({ method: 'GET', url: `/v1/memories/${f.event.eventId}`, headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({ method: 'POST', url: '/v1/ask', headers, payload: { query: f.error } })
      ).json().status,
    ).toBe('insufficient_evidence');
    expect(f.provider).not.toHaveBeenCalled();
  });
});
