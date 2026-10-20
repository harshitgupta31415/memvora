import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { deriveObservedMemory, LocalMemvora, redactText, runEnrichmentOnce } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'local-test-token-'.repeat(4);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
const cleanup: (() => void)[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const action of cleanup.splice(0)) action();
});

function setup() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Evidence test' });
  const session = store.createSession(service.context(), {
    repositoryId: repository.id,
    title: 'Investigate an observed failure',
  });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  const event = (sequence = 1): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence,
    startedAt: '2026-10-21T09:00:00.000Z',
    endedAt: '2026-10-21T09:00:01.000Z',
    command: { executable: 'node', args: ['--version'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stderr', ordinal: 0, text: 'ECONNREFUSED during database connection' }],
    diffs: [],
  });
  return { store, service, repository, session, app, event };
}

describe('local evidence lifecycle', () => {
  it('requires a bearer token and rejects hostile Host and Origin headers', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v1/dashboard' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/dashboard',
          headers: { ...headers, host: 'attacker.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/dashboard',
          headers: { ...headers, origin: 'https://attacker.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/dashboard', headers })).statusCode).toBe(
      200,
    );
  });

  it('acknowledges only durable UUIDs and safely resends after a lost response', async () => {
    const { app, event, store, service } = setup();
    const captured = event();
    for (let retry = 0; retry < 2; retry += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/events/batch',
        headers,
        payload: { schemaVersion: 1, events: [captured] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().acknowledgedEventIds).toEqual([captured.eventId]);
    }
    expect(store.dashboard(service.context()).counts).toMatchObject({
      events: 1,
      queuedJobs: 1,
      memories: 0,
    });
    expect(await runEnrichmentOnce(store)).toBe(true);
    expect(await runEnrichmentOnce(store)).toBe(false);
    const memory = store.getMemory(service.context(), captured.eventId);
    expect(memory.mode).toBe('observed');
    expect(memory.sources.map((source) => source.id)).toEqual([captured.eventId]);
    expect(memory.uncertainty.join(' ')).toContain('does not prove');
  });

  it('rejects an immutable conflict atomically without accepting another event', async () => {
    const { app, event, service, store } = setup();
    const first = event();
    service.ingest([first]);
    const newEvent = event(2);
    const conflict = { ...first, outcome: { ...first.outcome, exitCode: 0 } };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/events/batch',
      headers,
      payload: { schemaVersion: 1, events: [newEvent, conflict] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('IMMUTABLE_EVENT_CONFLICT');
    expect(store.dashboard(service.context()).counts.events).toBe(1);
    expect(() => store.getEvent(service.context(), newEvent.eventId)).toThrow();
  });

  it('rejects unknown fields and conflicting sequence identities', async () => {
    const { app, event, service, store } = setup();
    const first = event();
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/events/batch',
      headers,
      payload: { schemaVersion: 1, events: [{ ...first, injected: true }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.dashboard(service.context()).counts.events).toBe(0);
    service.ingest([first]);
    expect(() => service.ingest([event()])).toThrow(/sequence/);
  });

  it('orders out-of-order uploads and redacts known secrets before storage', () => {
    const { event, service, store, session } = setup();
    const second = event(2);
    const first = event(1);
    first.output[0]!.text =
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\npassword=hidden-value';
    service.ingest([second, first]);
    const context = store.getSession(service.context(), session.id);
    expect(context.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(JSON.stringify(context.events)).not.toContain('hidden-value');
    expect(JSON.stringify(context.events)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(context.events[0]?.capture.redacted).toBe(true);
  });

  it('redacts a known token split across output chunks without changing stream order', () => {
    const { event, service, store } = setup();
    const captured = event();
    captured.output = [
      { stream: 'stdout', ordinal: 0, text: 'ghp_abcdefghij' },
      { stream: 'stderr', ordinal: 1, text: 'diagnostic' },
      { stream: 'stdout', ordinal: 2, text: 'klmnopqrstuvwxyz123456' },
    ];
    service.ingest([captured]);
    const saved = store.getEvent(service.context(), captured.eventId);
    expect(saved.output.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
    expect(saved.output[1]?.text).toBe('diagnostic');
    expect(
      saved.output
        .filter((chunk) => chunk.stream === 'stdout')
        .map((chunk) => chunk.text)
        .join(''),
    ).not.toContain('abcdefghij');
  });

  it('redacts full bearer values and quoted JSON secrets with spaces using the shared policy', () => {
    const { event, service, store } = setup();
    const bearer = 'plain-bearer-credential-123456789';
    const input = `Authorization: Bearer ${bearer}\n{"password":"plain secret 123", "apiKey":"another quoted secret", "public":"keep this"}`;
    const safeText = redactText(input);
    for (const secret of [bearer, 'plain secret 123', 'another quoted secret'])
      expect(safeText).not.toContain(secret);
    expect(safeText).toContain('keep this');
    const captured = event();
    const split = input.indexOf('Bearer') + 9;
    captured.output = [
      { stream: 'stdout', ordinal: 0, text: input.slice(0, split) },
      { stream: 'stderr', ordinal: 1, text: 'keep diagnostic' },
      { stream: 'stdout', ordinal: 2, text: input.slice(split) },
    ];
    service.ingest([captured]);
    const saved = store.getEvent(service.context(), captured.eventId);
    const output = saved.output
      .filter((chunk) => chunk.stream === 'stdout')
      .map((chunk) => chunk.text)
      .join('');
    for (const secret of [bearer, 'plain secret 123', 'another quoted secret'])
      expect(output).not.toContain(secret);
    expect(output).not.toContain('quoted secret');
    expect(saved.output[1]?.text).toBe('keep diagnostic');
    expect(saved.output.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
  });

  it('redacts quoted secrets before imported repository context is persisted', () => {
    const { service, repository } = setup();
    service.saveRepositoryContext(repository.id, {
      provider: 'github',
      fullName: 'owner/repository',
      defaultBranch: 'main',
      commitSha: null,
      importedAt: '2026-10-21T09:00:00.000Z',
      files: [
        {
          path: 'config.example.json',
          sha: 'abc123',
          size: 120,
          text: '{"password":"plainsecret123","apiKey":"secret with spaces","public":"visible"}',
        },
      ],
      issues: [],
      pullRequests: [],
    });
    const stored = service.getRepositoryContext(repository.id);
    expect(stored?.files[0]?.text).not.toContain('plainsecret123');
    expect(stored?.files[0]?.text).not.toContain('secret with spaces');
    expect(stored?.files[0]?.text).toContain('visible');
    expect(JSON.parse(stored!.files[0]!.text)).toMatchObject({
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      public: 'visible',
    });
  });

  it('uses literal FTS queries within repository scope and removes deleted index records', async () => {
    const { event, service, store, repository, session } = setup();
    const first = event();
    first.output[0]!.text = 'error EADDRINUSE: listen 127.0.0.1:3000 C:\\project\\server.ts';
    const secondRepository = service.createRepository({ name: 'Separate repository' });
    const secondSession = store.createSession(service.context(), {
      repositoryId: secondRepository.id,
    });
    const other = {
      ...event(),
      eventId: randomUUID(),
      repositoryId: secondRepository.id,
      sessionId: secondSession.id,
    };
    service.ingest([first, other]);
    await runEnrichmentOnce(store);
    await runEnrichmentOnce(store);
    const found = store.search(service.context(), {
      query: 'EADDRINUSE:',
      repositoryIds: [repository.id],
    });
    expect(found.map((memory) => memory.id)).toEqual([first.eventId]);
    expect(
      store.search(service.context(), { query: 'ECONNREFUSED', repositoryIds: [repository.id] }),
    ).toEqual([]);
    expect(() => store.search(service.context(), { query: '" OR * % : ( )' })).not.toThrow();
    store.deleteSession(service.context(), session.id);
    expect(store.search(service.context(), { query: 'EADDRINUSE' })).toEqual([]);
    expect(
      store.search(service.context(), {
        query: 'ECONNREFUSED',
        repositoryIds: [secondRepository.id],
      }),
    ).toHaveLength(1);
  });

  it('never widens an inaccessible repository filter and returns insufficient evidence', async () => {
    const { app, event, service, store } = setup();
    service.ingest([event()]);
    await runEnrichmentOnce(store);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/memories/search',
      headers,
      payload: { query: 'ECONNREFUSED', repositoryIds: [randomUUID()] },
    });
    expect(denied.statusCode).toBe(404);
    const answer = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'unrecorded_unique_error' },
    });
    expect(answer.json()).toMatchObject({
      status: 'insufficient_evidence',
      sources: [],
      mode: 'observed',
    });
    const found = store.search(service.context(), { query: 'ECONNREFUSED' });
    expect(found).toHaveLength(1);
    expect(() =>
      store.getMemory(
        { ...service.context(), user: { id: randomUUID(), name: 'other' } },
        found[0]!.id,
      ),
    ).toThrow();
  });

  it('fences a delayed job and stale upload after confirmed session deletion', async () => {
    const { app, event, service, store, session } = setup();
    const captured = event();
    service.ingest([captured]);
    const job = store.claimJob();
    expect(job).not.toBeNull();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/sessions/${session.id}`,
          headers,
          payload: { confirm: false },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/sessions/${session.id}`,
          headers,
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.completeJob(job!, deriveObservedMemory(captured))).toBe(false);
    expect(() => service.ingest([captured])).toThrow();
    expect(store.dashboard(service.context()).counts).toMatchObject({
      events: 0,
      memories: 0,
      queuedJobs: 0,
    });
  });

  it('returns the latest bounded session window without hiding recent work', () => {
    const { event, service, store, session } = setup();
    const captured = Array.from({ length: 101 }, (_value, index) => event(index + 1));
    for (let offset = 0; offset < captured.length; offset += 50)
      service.ingest(captured.slice(offset, offset + 50));
    const context = store.getSession(service.context(), session.id);
    expect(context.session.eventCount).toBe(101);
    expect(context.events).toHaveLength(100);
    expect(context.events[0]?.sequence).toBe(2);
    expect(context.events.at(-1)?.eventId).toBe(captured.at(-1)?.eventId);
  });

  it('recalls a failed command with nearby verification even when the later output lacks the error', async () => {
    const { event, service, store } = setup();
    const failure = event(1);
    const verification = event(2);
    verification.outcome.exitCode = 0;
    verification.output = [{ stream: 'stdout', ordinal: 0, text: 'Connection check passed.' }];
    service.ingest([failure, verification]);
    await runEnrichmentOnce(store);
    await runEnrichmentOnce(store);
    const answer = service.ask({ query: 'ECONNREFUSED' }, 'recall-test');
    expect(answer.sources.map((source) => source.id)).toEqual([
      failure.eventId,
      verification.eventId,
    ]);
    expect(answer.steps.map((step) => step.text).join(' ')).toContain('code 0');
    expect(answer.answer).toContain('do not establish');
  });

  it('recalls an old error and its actual next verification outside the latest timeline window', async () => {
    const { event, service, store, session } = setup();
    const failure = event(1);
    failure.output = [{ stream: 'stderr', ordinal: 0, text: 'OLDER_REFERENCE_ERROR_927' }];
    service.ingest([failure]);
    await runEnrichmentOnce(store);
    const following = Array.from({ length: 102 }, (_value, index) => event(index + 2));
    following[0]!.outcome.exitCode = 0;
    following[0]!.output = [
      { stream: 'stdout', ordinal: 0, text: 'Verification passed after the recorded change.' },
    ];
    for (const captured of following.slice(1))
      captured.output = [{ stream: 'stdout', ordinal: 0, text: 'Later unrelated housekeeping.' }];
    for (let offset = 0; offset < following.length; offset += 50)
      service.ingest(following.slice(offset, offset + 50));
    expect(store.getSession(service.context(), session.id).events[0]?.sequence).toBe(4);
    const answer = service.ask({ query: 'OLDER_REFERENCE_ERROR_927' }, 'old-error-recall');
    expect(answer.sources.map((source) => source.id)).toContain(failure.eventId);
    expect(answer.sources.map((source) => source.id)).toContain(following[0]!.eventId);
    expect(answer.steps.map((step) => step.text).join(' ')).toContain('code 0');
    expect(store.neighborEvents(service.context(), failure.eventId, 99)).toHaveLength(4);
  });

  it('recognizes explicit recent-context requests while keeping unrelated queries insufficient', () => {
    const { event, service, store, repository } = setup();
    const first = event();
    service.ingest([first]);
    const otherRepository = service.createRepository({ name: 'Recent project' });
    const otherSession = store.createSession(service.context(), {
      repositoryId: otherRepository.id,
    });
    const latest = {
      ...event(),
      eventId: randomUUID(),
      repositoryId: otherRepository.id,
      sessionId: otherSession.id,
    };
    service.ingest([latest]);
    const empty = store.createSession(service.context(), {
      repositoryId: otherRepository.id,
      title: 'No capture yet',
    });
    // No enrichment has run: recent recall must use stored raw observations, not invented memory.
    for (const query of [
      'What failed in my last investigation?',
      'Which commands passed after the earlier failure?',
      'Where did I stop, and what is still unresolved?',
      'resume last investigation',
    ]) {
      const answer = service.ask({ query }, 'recent-context');
      expect(answer.status).toBe('answered');
      expect(answer.label).toContain('Recent investigation context');
      expect(answer.sources.map((source) => source.id)).toEqual([latest.eventId]);
      expect(answer.mode).toBe('observed');
    }
    const selected = service.ask(
      { query: 'resume last investigation', repositoryIds: [repository.id] },
      'selected-recent',
    );
    expect(selected.sources.map((source) => source.id)).toEqual([first.eventId]);
    expect(
      service.ask({ query: 'resume last investigation', repositoryIds: [] }, 'no-selected-repos'),
    ).toMatchObject({ status: 'insufficient_evidence', sources: [] });
    expect(
      service.ask({ query: 'unrecorded_unique_arbitrary_question' }, 'unrelated'),
    ).toMatchObject({ status: 'insufficient_evidence', sources: [] });
    expect(
      service.ask({ query: 'resume last investigation', sessionId: empty.id }, 'empty-session'),
    ).toMatchObject({ status: 'insufficient_evidence', sources: [] });
    expect(() =>
      service.ask(
        { query: 'resume last investigation', repositoryIds: [randomUUID()] },
        'denied-recent',
      ),
    ).toThrow();
  });

  it('keeps committed evidence on restart and never silently recreates a deleted workspace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-storage-'));
    cleanup.push(() => {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('memvora-storage-'))
        throw new Error('Unexpected storage test cleanup target.');
      rmSync(target, { recursive: true, force: true });
    });
    const path = join(directory, 'server.sqlite');
    const first = new SqliteEvidenceStore(path);
    const service = new LocalMemvora(first);
    const repository = service.createRepository({ name: 'Persistent repository' });
    const workspaceId = service.context().workspace.id;
    first.close();
    const reopened = new SqliteEvidenceStore(path);
    expect(reopened.context().workspace.id).toBe(workspaceId);
    expect(reopened.getRepository(reopened.context(), repository.id).name).toBe(
      'Persistent repository',
    );
    reopened.deleteWorkspace(reopened.context());
    reopened.close();
    const tombstone = new SqliteEvidenceStore(path);
    expect(() => tombstone.context()).toThrow(/deleted/);
    tombstone.close();
  });
});
