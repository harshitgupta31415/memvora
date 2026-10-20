import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvent, JobSummary } from '@memvora/contracts';
import { deriveObservedMemory, LocalMemvora } from '@memvora/core';
import type { EnrichmentJob } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'job-tests-local-token-'.repeat(3);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !/^memvora-job-(fence|migration)-/u.test(basename(target))
    )
      throw new Error('Unexpected job test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});

function setup(path = ':memory:') {
  const store = new SqliteEvidenceStore(path);
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Job test repository' });
  const session = store.createSession(service.context(), { repositoryId: repository.id });
  const event: CapturedEvent = {
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: 1,
    startedAt: '2026-10-21T09:00:00.000Z',
    endedAt: '2026-10-21T09:00:01.000Z',
    command: { executable: 'node', args: ['--version'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      {
        stream: 'stderr',
        ordinal: 0,
        text: 'Payload must remain available only through its evidence endpoint.',
      },
    ],
    diffs: [],
  };
  service.ingest([event]);
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  return { store, service, repository, session, event, app };
}

function exhaustAttempts(store: SqliteEvidenceStore): EnrichmentJob {
  let last: EnrichmentJob | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = store.claimJob();
    expect(last).not.toBeNull();
    store.failJob(last!);
    vi.setSystemTime(new Date(Date.now() + 10_000));
  }
  return last!;
}

describe('local enrichment job controls', () => {
  it('filters bounded safe projections without exposing evidence, credentials, or denied scopes', async () => {
    const { store, service, repository, session, event, app } = setup();
    const otherRepository = service.createRepository({ name: 'Other repository' });
    const otherSession = store.createSession(service.context(), {
      repositoryId: otherRepository.id,
    });
    service.ingest([
      {
        ...event,
        eventId: randomUUID(),
        repositoryId: otherRepository.id,
        sessionId: otherSession.id,
      },
    ]);
    expect((await app.inject({ method: 'GET', url: '/v1/jobs' })).statusCode).toBe(401);
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/jobs?repositoryId=${repository.id}&status=queued&limit=1`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json<{ items: JobSummary[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      eventId: event.eventId,
      status: 'queued',
      attempts: 0,
      retryCount: 0,
      maxAttempts: 3,
      lastError: null,
      canRetry: false,
    });
    expect(JSON.stringify(items)).not.toContain('Payload must remain');
    expect(JSON.stringify(items)).not.toContain(token);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/jobs?sessionId=${session.id}`, headers })).json()
        .items,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/jobs?repositoryId=${otherRepository.id}&sessionId=${session.id}`,
          headers,
        })
      ).json().items,
    ).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/jobs?repositoryId=${randomUUID()}`, headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/jobs?limit=101', headers })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/jobs?status=unknown', headers })).statusCode,
    ).toBe(400);
  });

  it('reschedules only failed work, preserves retry history and evidence, and rejects stale worker completion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store, service, event, app } = setup();
    const staleWorker = exhaustAttempts(store);
    expect(store.jobs(service.context(), { status: 'failed' })[0]).toMatchObject({
      attempts: 3,
      retryCount: 0,
      lastError: 'ENRICHMENT_FAILED',
      canRetry: true,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${event.eventId}/retry`,
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().job).toMatchObject({
      id: event.eventId,
      eventId: event.eventId,
      status: 'queued',
      attempts: 0,
      retryCount: 1,
      lastError: null,
      leaseUntil: null,
      canRetry: false,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${event.eventId}/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(store.completeJob(staleWorker, deriveObservedMemory(event))).toBe(false);
    const currentWorker = store.claimJob();
    expect(currentWorker).not.toBeNull();
    expect(store.completeJob(staleWorker, deriveObservedMemory(event))).toBe(false);
    expect(store.completeJob(currentWorker!, deriveObservedMemory(event))).toBe(true);
    expect(store.jobs(service.context())[0]).toMatchObject({
      status: 'ready',
      attempts: 1,
      retryCount: 1,
      canRetry: false,
    });
    expect(store.dashboard(service.context()).counts).toMatchObject({
      events: 1,
      memories: 1,
      failedJobs: 0,
    });
    expect(store.getEvent(service.context(), event.eventId)).toMatchObject({
      eventId: event.eventId,
      sequence: 1,
    });
  });

  it('does not reset queued, running, or ready jobs and validates retry requests', async () => {
    const { store, service, event, app } = setup();
    const retry = () =>
      app.inject({
        method: 'POST' as const,
        url: `/v1/jobs/${event.eventId}/retry`,
        headers,
        payload: {},
      });
    expect((await retry()).statusCode).toBe(409);
    const job = store.claimJob();
    expect(job).not.toBeNull();
    expect((await retry()).statusCode).toBe(409);
    store.completeJob(job!, deriveObservedMemory(event));
    expect((await retry()).statusCode).toBe(409);
    expect(store.jobs(service.context())[0]).toMatchObject({
      status: 'ready',
      attempts: 1,
      retryCount: 0,
    });
    expect(
      (await app.inject({ method: 'POST', url: `/v1/jobs/${event.eventId}/retry`, payload: {} }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${event.eventId}/retry`,
          headers: { ...headers, origin: 'https://attacker.example' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${event.eventId}/retry`,
          headers,
          payload: { force: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${randomUUID()}/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const foreignWorkspace = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${foreignWorkspace.event.eventId}/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/jobs?repositoryId=${foreignWorkspace.repository.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('hides stale-generation jobs and cannot restore deleted evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-job-fence-'));
    directories.push(directory);
    const { store, service, session, event, app } = setup(join(directory, 'server.sqlite'));
    const connection = new DatabaseSync(store.path);
    try {
      connection
        .prepare('UPDATE local_jobs SET session_generation=session_generation+1 WHERE id=?')
        .run(event.eventId);
    } finally {
      connection.close();
    }
    expect((await app.inject({ method: 'GET', url: '/v1/jobs', headers })).json().items).toEqual(
      [],
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${event.eventId}/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    store.deleteSession(service.context(), session.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/jobs/${event.eventId}/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(store.dashboard(service.context()).counts).toMatchObject({ events: 0, memories: 0 });
  });

  it('upgrades an existing version-2 store once and preserves its evidence on reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-job-migration-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const original = setup(path);
    const eventId = original.event.eventId;
    await original.app.close();
    apps.splice(apps.indexOf(original.app), 1);
    const previousVersion = new DatabaseSync(path);
    try {
      previousVersion.exec(
        'ALTER TABLE local_jobs DROP COLUMN retry_count; PRAGMA user_version=2;',
      );
    } finally {
      previousVersion.close();
    }
    const upgraded = new SqliteEvidenceStore(path);
    try {
      expect(upgraded.jobs(upgraded.context())[0]).toMatchObject({
        eventId,
        retryCount: 0,
        status: 'queued',
      });
      expect(upgraded.getEvent(upgraded.context(), eventId).eventId).toBe(eventId);
    } finally {
      upgraded.close();
    }
    const reopened = new SqliteEvidenceStore(path);
    try {
      expect(reopened.jobs(reopened.context())[0]?.retryCount).toBe(0);
    } finally {
      reopened.close();
    }
    const tooNew = new DatabaseSync(path);
    try {
      tooNew.exec('PRAGMA user_version=6;');
    } finally {
      tooNew.close();
    }
    expect(() => new SqliteEvidenceStore(path)).toThrow(/newer/);
  });
});
