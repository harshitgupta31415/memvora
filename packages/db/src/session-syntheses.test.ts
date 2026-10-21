import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CapturedEvent,
  LocalContext,
  SessionSynthesisAnalysis,
  SessionSynthesisConfiguration,
} from '@memvora/contracts';
import { DomainError, prepareEvents } from '@memvora/core';
import type { SessionSynthesisJob } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const configuration: SessionSynthesisConfiguration = {
  provider: 'synthetic-fixture',
  model: 'fixture-analysis',
  fingerprint: 'a'.repeat(64),
  promptVersion: 'session-analysis-v1',
};
const replacement = { ...configuration, fingerprint: 'b'.repeat(64), model: 'replacement' };
const stores: SqliteEvidenceStore[] = [];
const folders: string[] = [];
const temporaryRoot = realpathSync(tmpdir());
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (!existsSync(folder)) continue;
    const target = realpathSync(resolve(folder));
    if (
      dirname(target) !== temporaryRoot ||
      !target.startsWith(join(temporaryRoot, 'memvora-synthesis-')) ||
      !basename(target).startsWith('memvora-synthesis-')
    )
      throw new Error('Unsafe synthesis fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
function open(path = ':memory:') {
  const store = new SqliteEvidenceStore(path);
  stores.push(store);
  return store;
}
function database(store: SqliteEvidenceStore) {
  return (store as unknown as { database: DatabaseSync }).database;
}
function fixture(path = ':memory:', eventCount = 2) {
  const store = open(path);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Synthetic analysis repository' });
  const session = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Synthetic connection investigation',
  });
  const event = (sequence: number, sessionId = session.id): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId,
    sequence,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'synthetic-observation', args: ['check'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: sequence === 2 ? 1 : 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stdout', ordinal: 0, text: `Synthetic step ${sequence}` }],
    diffs: [],
  });
  if (eventCount)
    store.ingest(
      context,
      prepareEvents(Array.from({ length: eventCount }, (_, i) => event(i + 2))),
    );
  const preview = () => store.getSessionSynthesisPreview(context, session.id, configuration);
  const request = () => {
    const snapshot = preview();
    const input = { requestId: randomUUID(), expectedInputHash: snapshot.inputHash! };
    return { ...store.requestSessionSynthesis(context, session.id, input, configuration), input };
  };
  return { store, context, repository, session, event, preview, request };
}
function claim(store: SqliteEvidenceStore): SessionSynthesisJob {
  const job = store.claimSessionSynthesis(configuration);
  expect(job).not.toBeNull();
  return job!;
}
function analysis(job: SessionSynthesisJob): SessionSynthesisAnalysis {
  return {
    overview: {
      text: 'The supplied commands provide observations; their causal relationship is uncertain.',
      sourceIds: [job.input.events[0]!.id, job.input.events[1]!.id],
    },
    hypotheses: [],
    unresolvedQuestions: [],
    suggestedChecks: [],
    uncertainty: ['A command exit does not independently verify the root cause.'],
  };
}
function rejects(action: () => unknown, code: string, statusCode?: number) {
  try {
    action();
    throw new Error('Expected the synthesis operation to be rejected.');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code, ...(statusCode === undefined ? {} : { statusCode }) });
  }
}
function count(store: SqliteEvidenceStore) {
  return Number(
    database(store).prepare('SELECT count(*) AS count FROM local_session_syntheses').get()![
      'count'
    ],
  );
}

describe('durable explicit session synthesis', () => {
  it('keeps previews and status reads read-only and distinguishes disabled from insufficient evidence', () => {
    const f = fixture(':memory:', 0);
    const before = database(f.store).prepare('SELECT total_changes() AS count').get()!['count'];
    expect(f.store.getSessionSynthesisPreview(f.context, f.session.id, null)).toMatchObject({
      availability: 'disabled',
      inputHash: null,
      coverage: { totalEvents: 0 },
      sourceIds: [],
    });
    expect(f.preview()).toMatchObject({
      availability: 'insufficient_evidence',
      inputBytes: expect.any(Number),
    });
    expect(f.store.getSessionSynthesis(f.context, f.session.id, configuration).request).toBeNull();
    expect(database(f.store).prepare('SELECT total_changes() AS count').get()!['count']).toBe(
      before,
    );
    rejects(
      () =>
        f.store.requestSessionSynthesis(
          f.context,
          f.session.id,
          {
            requestId: randomUUID(),
            expectedInputHash: '0'.repeat(64),
          },
          null,
        ),
      'SYNTHESIS_DISABLED',
      503,
    );
    rejects(() => f.request(), 'INSUFFICIENT_SYNTHESIS_EVIDENCE', 422);
    expect(count(f.store)).toBe(0);
  });

  it('atomically records bounded input, preserves replay identity and rejects a changed UUID payload or stale preview', () => {
    const f = fixture();
    const initial = f.request();
    expect(initial.created).toBe(true);
    expect(initial.request).toMatchObject({
      status: 'queued',
      attempts: 0,
      stale: false,
      analysis: null,
    });
    const stored = database(f.store)
      .prepare('SELECT input_json,revision_json FROM local_session_syntheses')
      .get()!;
    expect(Buffer.byteLength(String(stored['input_json']), 'utf8')).toBeLessThanOrEqual(65_536);
    f.store.ingest(f.context, prepareEvents([f.event(1)]));
    const replay = f.store.requestSessionSynthesis(f.context, f.session.id, initial.input, null);
    expect(replay.created).toBe(false);
    expect(replay.request).toMatchObject({
      id: initial.request.id,
      createdAt: initial.request.createdAt,
      stale: true,
    });
    expect(count(f.store)).toBe(1);
    rejects(
      () =>
        f.store.requestSessionSynthesis(
          f.context,
          f.session.id,
          {
            ...initial.input,
            expectedInputHash: 'f'.repeat(64),
          },
          configuration,
        ),
      'IMMUTABLE_SYNTHESIS_CONFLICT',
      409,
    );
    rejects(
      () =>
        f.store.requestSessionSynthesis(
          f.context,
          f.session.id,
          {
            requestId: randomUUID(),
            expectedInputHash: initial.input.expectedInputHash,
          },
          configuration,
        ),
      'SYNTHESIS_INPUT_CHANGED',
      409,
    );
    const other = f.store.createSession(f.context, { repositoryId: f.repository.id });
    rejects(
      () => f.store.requestSessionSynthesis(f.context, other.id, initial.input, null),
      'NOT_FOUND',
      404,
    );
    expect(count(f.store)).toBe(1);
    expect(
      database(f.store).prepare('SELECT revision_json FROM local_session_syntheses').get()![
        'revision_json'
      ],
    ).toBe(stored['revision_json']);
  });

  it('permits one active request, publishes a cited result once, and returns the latest request deterministically', () => {
    const f = fixture();
    const first = f.request();
    rejects(() => f.request(), 'SYNTHESIS_IN_PROGRESS', 409);
    const job = claim(f.store);
    expect(
      f.store.getSessionSynthesis(f.context, f.session.id, configuration).request,
    ).toMatchObject({ status: 'running', attempts: 1, startedAt: expect.any(String) });
    expect(f.store.claimSessionSynthesis(configuration)).toBeNull();
    expect(f.store.completeSessionSynthesis(job, analysis(job))).toBe(true);
    expect(f.store.completeSessionSynthesis(job, analysis(job))).toBe(false);
    const ready = f.store.getSessionSynthesis(
      f.context,
      f.session.id,
      configuration,
      first.request.id,
    ).request!;
    expect(ready).toMatchObject({
      status: 'ready',
      attempts: 1,
      stale: false,
      failureCode: null,
      analysis: analysis(job),
    });
    expect(ready.sources.map((source) => source.id)).toEqual(
      job.input.events.map((event) => event.id),
    );
    const second = f.request();
    expect(second.request.createdAt >= first.request.createdAt).toBe(true);
    expect(f.store.getSessionSynthesis(f.context, f.session.id, configuration).request?.id).toBe(
      second.request.id,
    );
    expect(
      f.store.getSessionSynthesis(f.context, f.session.id, configuration, first.request.id).request
        ?.status,
    ).toBe('ready');
  });

  it('never retries failed or expired running work and fences late completions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));
    const f = fixture();
    const first = f.request();
    const failed = claim(f.store);
    f.store.failSessionSynthesis(failed);
    expect(f.store.claimSessionSynthesis(configuration)).toBeNull();
    expect(
      f.store.getSessionSynthesis(f.context, f.session.id, configuration, first.request.id).request,
    ).toMatchObject({ status: 'failed', failureCode: 'PROVIDER_FAILED', attempts: 1 });
    expect(f.store.completeSessionSynthesis(failed, analysis(failed))).toBe(false);
    const second = f.request();
    const expired = claim(f.store);
    vi.advanceTimersByTime(120_001);
    expect(f.store.claimSessionSynthesis(replacement)).toBeNull();
    expect(
      f.store.getSessionSynthesis(f.context, f.session.id, replacement, second.request.id).request,
    ).toMatchObject({ status: 'failed', failureCode: 'INTERRUPTED', attempts: 1, stale: true });
    expect(f.store.completeSessionSynthesis(expired, analysis(expired))).toBe(false);
    expect(f.store.claimSessionSynthesis(configuration)).toBeNull();
  });

  it('supersedes queued and running requests when configuration changes, including disablement', () => {
    const f = fixture();
    const queued = f.request();
    expect(f.store.claimSessionSynthesis(replacement)).toBeNull();
    expect(
      f.store.getSessionSynthesis(f.context, f.session.id, replacement, queued.request.id).request,
    ).toMatchObject({
      status: 'superseded',
      attempts: 0,
      failureCode: 'CONFIGURATION_CHANGED',
      stale: true,
    });
    const running = f.request();
    const job = claim(f.store);
    expect(f.store.claimSessionSynthesis(null)).toBeNull();
    expect(f.store.completeSessionSynthesis(job, analysis(job))).toBe(false);
    expect(
      f.store.getSessionSynthesis(f.context, f.session.id, null, running.request.id).request,
    ).toMatchObject({
      status: 'superseded',
      attempts: 1,
      failureCode: 'CONFIGURATION_CHANGED',
      analysis: null,
    });
  });

  it.each(['late-event', 'note', 'close'] as const)(
    'fences %s evidence changes before claim or publication',
    (change) => {
      const f = fixture();
      const initial = f.request();
      const job = claim(f.store);
      if (change === 'late-event') f.store.ingest(f.context, prepareEvents([f.event(1)]));
      else if (change === 'note')
        f.store.createSessionNote(f.context, f.session.id, {
          id: randomUUID(),
          kind: 'decision',
          body: 'Author reports the next check is unresolved.',
          eventIds: [],
        });
      else f.store.closeSession(f.context, f.session.id);
      const before = database(f.store).prepare('SELECT total_changes() AS count').get()!['count'];
      expect(
        f.store.getSessionSynthesis(f.context, f.session.id, configuration).request?.stale,
      ).toBe(true);
      expect(database(f.store).prepare('SELECT total_changes() AS count').get()!['count']).toBe(
        before,
      );
      expect(f.store.completeSessionSynthesis(job, analysis(job))).toBe(false);
      expect(
        f.store.getSessionSynthesis(f.context, f.session.id, configuration, initial.request.id)
          .request,
      ).toMatchObject({ status: 'superseded', failureCode: 'INPUT_CHANGED', analysis: null });
      const queued = f.request();
      f.store.ingest(f.context, prepareEvents([f.event(4)]));
      expect(f.store.claimSessionSynthesis(configuration)).toBeNull();
      expect(
        f.store.getSessionSynthesis(f.context, f.session.id, configuration, queued.request.id)
          .request,
      ).toMatchObject({ status: 'superseded', attempts: 0, failureCode: 'INPUT_CHANGED' });
    },
  );

  it('validates result citations against persisted input, rather than trusting a worker-supplied replacement', () => {
    const f = fixture();
    f.request();
    const job = claim(f.store);
    const foreignId = randomUUID();
    const tampered = structuredClone(job);
    tampered.input.events[0]!.id = foreignId;
    const response = analysis(job);
    response.overview.sourceIds = [foreignId];
    rejects(
      () => f.store.completeSessionSynthesis(tampered, response),
      'INVALID_SYNTHESIS_EVIDENCE',
      502,
    );
    expect(
      f.store.getSessionSynthesis(f.context, f.session.id, configuration).request,
    ).toMatchObject({ status: 'running', analysis: null });
    expect(f.store.completeSessionSynthesis(job, analysis(job))).toBe(true);
  });

  it.each(['session', 'repository', 'workspace'] as const)(
    'physically removes %s analyses and prevents delayed resurrection',
    (parent) => {
      const f = fixture();
      const initial = f.request();
      const job = claim(f.store);
      if (parent === 'session') f.store.deleteSession(f.context, f.session.id);
      else if (parent === 'repository') f.store.deleteRepository(f.context, f.repository.id);
      else f.store.deleteWorkspace(f.context);
      expect(count(f.store)).toBe(0);
      expect(f.store.completeSessionSynthesis(job, analysis(job))).toBe(false);
      f.store.failSessionSynthesis(job);
      expect(count(f.store)).toBe(0);
      rejects(
        () =>
          f.store.getSessionSynthesis(f.context, f.session.id, configuration, initial.request.id),
        parent === 'workspace' ? 'WORKSPACE_UNAVAILABLE' : 'NOT_FOUND',
      );
    },
  );

  it('denies foreign callers and fences stale workspace, repository and session generations', () => {
    const f = fixture();
    const first = f.request();
    const foreign: LocalContext = {
      ...f.context,
      user: { id: randomUUID(), name: 'Other caller' },
    };
    rejects(
      () => f.store.getSessionSynthesisPreview(foreign, f.session.id, configuration),
      'WORKSPACE_UNAVAILABLE',
    );
    rejects(
      () => f.store.getSessionSynthesis(foreign, f.session.id, configuration, first.request.id),
      'WORKSPACE_UNAVAILABLE',
    );
    for (const table of ['local_sessions', 'local_repositories', 'local_workspaces']) {
      const g = fixture();
      const initial = g.request();
      const job = claim(g.store);
      const id =
        table === 'local_sessions'
          ? g.session.id
          : table === 'local_repositories'
            ? g.repository.id
            : g.context.workspace.id;
      database(g.store).prepare(`UPDATE ${table} SET generation=generation+1 WHERE id=?`).run(id);
      expect(g.store.completeSessionSynthesis(job, analysis(job))).toBe(false);
      const context = table === 'local_workspaces' ? g.store.context() : g.context;
      rejects(
        () => g.store.getSessionSynthesis(context, g.session.id, configuration, initial.request.id),
        'NOT_FOUND',
      );
      if (table === 'local_workspaces') rejects(() => g.preview(), 'WORKSPACE_UNAVAILABLE');
    }
  });

  it('enforces retained per-session and workspace admission limits without replacing existing requests', () => {
    const f = fixture();
    for (let index = 0; index < 32; index++) {
      f.request();
      f.store.failSessionSynthesis(claim(f.store));
    }
    rejects(() => f.request(), 'SYNTHESIS_QUOTA', 409);
    expect(count(f.store)).toBe(32);
    for (let sessionIndex = 1; sessionIndex < 16; sessionIndex++) {
      const session = f.store.createSession(f.context, { repositoryId: f.repository.id });
      f.store.ingest(f.context, prepareEvents([f.event(1, session.id), f.event(2, session.id)]));
      const preview = f.store.getSessionSynthesisPreview(f.context, session.id, configuration);
      for (let index = 0; index < 32; index++) {
        f.store.requestSessionSynthesis(
          f.context,
          session.id,
          { requestId: randomUUID(), expectedInputHash: preview.inputHash! },
          configuration,
        );
        f.store.failSessionSynthesis(claim(f.store));
      }
    }
    const extra = f.store.createSession(f.context, { repositoryId: f.repository.id });
    f.store.ingest(f.context, prepareEvents([f.event(1, extra.id), f.event(2, extra.id)]));
    const preview = f.store.getSessionSynthesisPreview(f.context, extra.id, configuration);
    rejects(
      () =>
        f.store.requestSessionSynthesis(
          f.context,
          extra.id,
          { requestId: randomUUID(), expectedInputHash: preview.inputHash! },
          configuration,
        ),
      'SYNTHESIS_QUOTA',
      409,
    );
    expect(count(f.store)).toBe(512);
  });

  it('migrates schema8 without rewriting evidence or cursor state, and retains requests through restart', () => {
    const directory = mkdtempSync(join(temporaryRoot, 'memvora-synthesis-'));
    folders.push(directory);
    const path = join(directory, 'server.sqlite');
    const f = fixture(path, 3);
    const cursor = f.store.getSessionEvents(f.context, f.session.id, { limit: 1 }).page
      .olderCursor!;
    const before = database(f.store)
      .prepare(
        'SELECT e.id,e.payload_json,e.digest,i.id AS intake,j.status FROM local_events e JOIN local_event_intakes i ON i.event_id=e.id JOIN local_jobs j ON j.event_id=e.id ORDER BY i.id',
      )
      .all();
    const secret = database(f.store)
      .prepare('SELECT cursor_secret FROM local_history_state')
      .get()!['cursor_secret'];
    f.store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE local_session_syntheses; PRAGMA user_version=8;');
    legacy.close();
    const migrated = open(path);
    expect(database(migrated).prepare('PRAGMA user_version').get()!['user_version']).toBe(9);
    expect(
      database(migrated)
        .prepare(
          'SELECT e.id,e.payload_json,e.digest,i.id AS intake,j.status FROM local_events e JOIN local_event_intakes i ON i.event_id=e.id JOIN local_jobs j ON j.event_id=e.id ORDER BY i.id',
        )
        .all(),
    ).toEqual(before);
    expect(
      database(migrated).prepare('SELECT cursor_secret FROM local_history_state').get()![
        'cursor_secret'
      ],
    ).toBe(secret);
    expect(
      migrated
        .getSessionEvents(f.context, f.session.id, { cursor, limit: 1 })
        .events.map((event) => event.sequence),
    ).toEqual([3]);
    const preview = migrated.getSessionSynthesisPreview(f.context, f.session.id, configuration);
    const input = { requestId: randomUUID(), expectedInputHash: preview.inputHash! };
    const initial = migrated.requestSessionSynthesis(f.context, f.session.id, input, configuration);
    const job = claim(migrated);
    migrated.close();
    const reopened = open(path);
    expect(
      reopened.requestSessionSynthesis(f.context, f.session.id, input, configuration),
    ).toMatchObject({
      created: false,
      request: { id: initial.request.id, status: 'running', attempts: 1 },
    });
    expect(reopened.completeSessionSynthesis(job, analysis(job))).toBe(true);
    expect(
      reopened.getSessionSynthesis(f.context, f.session.id, configuration).request?.status,
    ).toBe('ready');
  });
});
