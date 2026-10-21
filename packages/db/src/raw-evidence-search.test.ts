import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent, LocalContext, Memory } from '@memvora/contracts';
import { deriveObservedMemory, prepareEvents } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
const temporaryRoot = realpathSync(tmpdir());
const folders: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (!existsSync(folder)) continue;
    const target = realpathSync(folder);
    if (
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-raw-search-') ||
      !target.startsWith(join(temporaryRoot, 'memvora-raw-search-'))
    )
      throw new Error('Unsafe raw-search fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
const database = (store: SqliteEvidenceStore) =>
  (store as unknown as { database: DatabaseSync }).database;
function open(path = ':memory:') {
  const store = new SqliteEvidenceStore(path);
  stores.push(store);
  return store;
}
function path() {
  const directory = mkdtempSync(join(temporaryRoot, 'memvora-raw-search-'));
  folders.push(directory);
  return join(directory, 'server.sqlite');
}
function fixture(file = ':memory:') {
  const store = open(file);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Synthetic raw evidence' });
  const session = store.createSession(context, { repositoryId: repository.id });
  const event = (sequence = 1, text = 'RawErrorNeedle'): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'node', args: ['synthetic.js'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stderr', ordinal: 0, text }],
    diffs: [],
  });
  const ingest = (events: CapturedEvent[]) => {
    for (let offset = 0; offset < events.length; offset += 50)
      store.ingest(context, prepareEvents(events.slice(offset, offset + 50)));
  };
  return { store, context, repository, session, event, ingest };
}
function retainedState(store: SqliteEvidenceStore) {
  const db = database(store);
  const tables = [
    'local_identity',
    'local_workspaces',
    'local_repositories',
    'local_sessions',
    'local_events',
    'local_event_intakes',
    'local_history_state',
    'local_jobs',
    'local_memories',
    'local_session_notes',
    'local_repository_sources',
    'sqlite_sequence',
  ];
  return tables.map((table) => [
    table,
    db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort(),
  ]);
}
function expectNotFound(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
}

describe('raw evidence recall independent of enrichment', () => {
  it('finds queued, running and failed captures without creating memories or changing processing', () => {
    const f = fixture();
    const events = [
      f.event(1, 'QueuedRawNeedle'),
      f.event(2, 'RunningRawNeedle'),
      f.event(3, 'FailedRawNeedle'),
    ];
    f.ingest(events);
    database(f.store)
      .prepare(
        "UPDATE local_jobs SET status='running',attempts=1,lease_token=?,lease_until=? WHERE id=?",
      )
      .run(randomUUID(), '2099-01-01T00:00:00.000Z', events[1]!.eventId);
    database(f.store)
      .prepare(
        "UPDATE local_jobs SET status='failed',attempts=3,last_error='ENRICHMENT_FAILED' WHERE id=?",
      )
      .run(events[2]!.eventId);
    const before = retainedState(f.store);
    const changes = database(f.store).prepare('SELECT total_changes() AS count').get()?.['count'];
    for (const [index, status] of ['queued', 'running', 'failed'].entries()) {
      const result = f.store.search(f.context, {
        query: ['QueuedRawNeedle', 'RunningRawNeedle', 'FailedRawNeedle'][index]!,
        limit: 20,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: events[index]!.eventId,
        mode: 'observed',
        representation: 'raw_event',
        processingStatus: status,
      });
      expect(result[0]?.sources.map((source) => source.id)).toEqual([events[index]!.eventId]);
      expect(f.store.getMemory(f.context, events[index]!.eventId)).toEqual(result[0]);
      expect(f.store.getEvent(f.context, events[index]!.eventId)).toEqual(events[index]);
    }
    expect(
      database(f.store).prepare('SELECT count(*) AS count FROM local_memories').get()?.['count'],
    ).toBe(0);
    expect(retainedState(f.store)).toEqual(before);
    expect(database(f.store).prepare('SELECT total_changes() AS count').get()?.['count']).toBe(
      changes,
    );
  });

  it('prefers an unchanged stored summary for raw-only arguments, startup error and diff matches', () => {
    const f = fixture();
    const event = f.event();
    event.command.args = ['OnlyRawArgumentNeedle'];
    event.output = [];
    event.outcome = {
      kind: 'spawn_failed',
      exitCode: null,
      signal: null,
      error: { code: 'OnlyRawStartupNeedle', message: 'Synthetic missing executable' },
    };
    event.diffs = [{ phase: 'before', text: 'OnlyRawDiffNeedle', truncatedBytes: 0 }];
    f.ingest([event]);
    const job = f.store.claimJob()!;
    const memory: Memory = {
      ...deriveObservedMemory(event),
      mode: 'ai',
      label: 'AI-assisted synthetic fixture',
      title: 'General summary',
      summary: 'Stored explanation with no search markers.',
      steps: [{ text: 'An observed startup attempt.', sourceIds: [event.eventId] }],
    };
    expect(f.store.completeJob(job, memory)).toBe(true);
    for (const query of ['OnlyRawArgumentNeedle', 'OnlyRawStartupNeedle', 'OnlyRawDiffNeedle']) {
      const result = f.store.search(f.context, { query });
      expect(result).toEqual([memory]);
      expect(result[0]?.representation).toBeUndefined();
    }
    expect(f.store.getMemory(f.context, event.eventId)).toEqual(memory);
  });

  it('deduplicates raw/summary candidates before returning twenty distinct matches', () => {
    const f = fixture();
    const events = Array.from({ length: 25 }, (_, index) =>
      f.event(index + 1, 'SharedDedupNeedle'),
    );
    f.ingest(events);
    for (let job = f.store.claimJob(); job; job = f.store.claimJob())
      f.store.completeJob(job, deriveObservedMemory(job.event));
    const result = f.store.search(f.context, { query: 'SharedDedupNeedle', limit: 20 });
    expect(result).toHaveLength(20);
    expect(new Set(result.map((memory) => memory.id)).size).toBe(20);
    expect(result.every((memory) => memory.representation === undefined)).toBe(true);
  });

  it('applies repository/session/owner scope before candidate limits and rejects stale context', () => {
    const f = fixture();
    const first = f.event(1, 'ScopedRawNeedle');
    f.ingest([first]);
    const noise = f.store.createRepository(f.context, { name: 'Unselected raw scope' });
    const noiseSession = f.store.createSession(f.context, { repositoryId: noise.id });
    f.ingest(
      Array.from({ length: 125 }, (_, index) => ({
        ...f.event(index + 1, 'ScopedRawNeedle'),
        repositoryId: noise.id,
        sessionId: noiseSession.id,
      })),
    );
    const foreign: LocalContext = {
      mode: 'local',
      user: { id: randomUUID(), name: 'Foreign synthetic owner' },
      workspace: { id: randomUUID(), name: 'Foreign synthetic workspace', generation: 1 },
    };
    database(f.store)
      .prepare(
        "INSERT INTO local_workspaces(id,owner_user_id,name,generation,status,created_at) VALUES(?,?,?,1,'active',?)",
      )
      .run(
        foreign.workspace.id,
        foreign.user.id,
        foreign.workspace.name,
        '2026-10-21T10:00:00.000Z',
      );
    const foreignRepo = f.store.createRepository(foreign, { name: 'Foreign synthetic raw scope' });
    const foreignSession = f.store.createSession(foreign, { repositoryId: foreignRepo.id });
    const foreignEvent = {
      ...f.event(1, 'ScopedRawNeedle'),
      repositoryId: foreignRepo.id,
      sessionId: foreignSession.id,
    };
    f.store.ingest(foreign, prepareEvents([foreignEvent]));
    expect(
      f.store
        .search(f.context, { query: 'ScopedRawNeedle', repositoryIds: [f.repository.id] })
        .map((memory) => memory.id),
    ).toEqual([first.eventId]);
    expect(
      f.store
        .search(f.context, { query: 'ScopedRawNeedle' }, f.session.id)
        .map((memory) => memory.id),
    ).toEqual([first.eventId]);
    expect(f.store.search(f.context, { query: 'ScopedRawNeedle', repositoryIds: [] })).toEqual([]);
    expectNotFound(() =>
      f.store.search(f.context, { query: 'ScopedRawNeedle', repositoryIds: [foreignRepo.id] }),
    );
    expectNotFound(() => f.store.getMemory(f.context, foreignEvent.eventId));
    expect(
      f.store.search(foreign, { query: 'ScopedRawNeedle' }).map((memory) => memory.id),
    ).toEqual([foreignEvent.eventId]);
    expect(() =>
      f.store.search(
        { ...f.context, user: { ...f.context.user, id: randomUUID() } },
        { query: 'ScopedRawNeedle' },
      ),
    ).toThrow();
    database(f.store)
      .prepare('UPDATE local_workspaces SET generation=generation+1 WHERE id=?')
      .run(f.context.workspace.id);
    expect(() => f.store.search(f.context, { query: 'ScopedRawNeedle' })).toThrow();
    expect(() => f.store.getMemory(f.context, first.eventId)).toThrow();
  });

  it('indexes redacted field values, late output and literal punctuation without JSON-key noise or FTS operators', () => {
    const f = fixture();
    const event = f.event(
      1,
      `${'ordinary prefix '.repeat(250)}Error: EPORT::100% LateOutputNeedle\npassword=PrivateRawIndexSecret123`,
    );
    f.ingest([event]);
    expect(
      f.store.search(f.context, { query: 'LateOutputNeedle' }).map((memory) => memory.id),
    ).toEqual([event.eventId]);
    expect(f.store.search(f.context, { query: 'EPORT::100%' }).map((memory) => memory.id)).toEqual([
      event.eventId,
    ]);
    expect(f.store.search(f.context, { query: 'PrivateRawIndexSecret123' })).toEqual([]);
    expect(f.store.search(f.context, { query: 'truncatedBytes' })).toEqual([]);
    expect(f.store.search(f.context, { query: '" OR local_event_fts:*' })).toEqual([]);
    const text = database(f.store).prepare('SELECT searchable_text FROM local_event_fts').get()?.[
      'searchable_text'
    ];
    expect(text).not.toContain('PrivateRawIndexSecret123');
    const raw = f.store.getMemory(f.context, event.eventId);
    expect(raw.uncertainty.join(' ')).toContain('excerpt');
    expect(f.store.getEvent(f.context, event.eventId).output[0]?.text).toContain(
      'LateOutputNeedle',
    );
  });

  it('omits missing or stale job status without inventing an enrichment completion', () => {
    const f = fixture();
    const first = f.event(1, 'UnknownStatusNeedle');
    const second = f.event(2, 'StaleStatusNeedle');
    f.ingest([first, second]);
    database(f.store).prepare('DELETE FROM local_jobs WHERE event_id=?').run(first.eventId);
    database(f.store)
      .prepare(
        'UPDATE local_jobs SET repository_generation=repository_generation+1 WHERE event_id=?',
      )
      .run(second.eventId);
    for (const event of [first, second])
      expect(f.store.getMemory(f.context, event.eventId)).toMatchObject({
        representation: 'raw_event',
        mode: 'observed',
      });
    expect(f.store.getMemory(f.context, first.eventId).processingStatus).toBeUndefined();
    expect(f.store.getMemory(f.context, second.eventId).processingStatus).toBeUndefined();
  });

  it('removes raw index entries with session/repository/workspace deletion and denies all stale reads', () => {
    const f = fixture();
    const event = f.event();
    f.ingest([event]);
    f.store.deleteSession(f.context, f.session.id);
    expect(f.store.search(f.context, { query: 'RawErrorNeedle' })).toEqual([]);
    expectNotFound(() => f.store.getMemory(f.context, event.eventId));
    expect(
      database(f.store).prepare('SELECT count(*) AS count FROM local_event_fts').get()?.['count'],
    ).toBe(0);
    const session = f.store.createSession(f.context, { repositoryId: f.repository.id });
    const later = { ...f.event(), sessionId: session.id };
    f.ingest([later]);
    f.store.deleteRepository(f.context, f.repository.id);
    expect(f.store.search(f.context, { query: 'RawErrorNeedle' })).toEqual([]);
    expectNotFound(() => f.store.getMemory(f.context, later.eventId));
    const repository = f.store.createRepository(f.context, { name: 'Last synthetic scope' });
    const lastSession = f.store.createSession(f.context, { repositoryId: repository.id });
    const last = { ...f.event(), repositoryId: repository.id, sessionId: lastSession.id };
    f.ingest([last]);
    f.store.deleteWorkspace(f.context);
    expect(
      database(f.store).prepare('SELECT count(*) AS count FROM local_event_fts').get()?.['count'],
    ).toBe(0);
    expect(() => f.store.getMemory(f.context, last.eventId)).toThrow();
    expect(() => f.store.search(f.context, { query: 'RawErrorNeedle' })).toThrow();
  });

  it('backfills schema7 across restart without changing evidence, summaries, leases, UUIDs or cursor state', () => {
    const file = path();
    const f = fixture(file);
    const events = [
      f.event(1, 'LegacyQueuedNeedle'),
      f.event(2, 'LegacyQueuedNeedle'),
      f.event(3, 'LegacyQueuedNeedle'),
    ];
    f.ingest(events);
    const job = f.store.claimJob()!;
    f.store.completeJob(job, deriveObservedMemory(job.event));
    const cursor = f.store.getSessionEvents(f.context, f.session.id, { limit: 1 });
    expect(cursor.page.olderCursor).not.toBeNull();
    const before = retainedState(f.store);
    f.store.close();
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec(
        'DROP TRIGGER local_event_fts_delete; DROP TABLE local_event_fts; PRAGMA user_version=7',
      );
    } finally {
      legacy.close();
    }
    const upgraded = open(file);
    expect(database(upgraded).prepare('PRAGMA user_version').get()?.['user_version']).toBe(9);
    expect(retainedState(upgraded)).toEqual(before);
    expect(
      database(upgraded).prepare('SELECT count(*) AS count FROM local_event_fts').get()?.['count'],
    ).toBe(3);
    expect(upgraded.search(f.context, { query: 'LegacyQueuedNeedle', limit: 20 })).toHaveLength(3);
    expect(
      upgraded
        .getSessionEvents(f.context, f.session.id, { limit: 1, cursor: cursor.page.olderCursor! })
        .events.map((event) => event.sequence),
    ).toEqual([2]);
    const afterMigration = retainedState(upgraded);
    upgraded.close();
    const reopened = open(file);
    expect(retainedState(reopened)).toEqual(afterMigration);
    expect(reopened.search(f.context, { query: 'LegacyQueuedNeedle' })).toHaveLength(3);
    expect(
      database(reopened).prepare('SELECT count(*) AS count FROM local_event_fts').get()?.['count'],
    ).toBe(3);
  });

  it('rolls back raw indexing with failed queue scheduling or a later immutable batch conflict', () => {
    const f = fixture();
    const first = f.event();
    database(f.store).exec(
      "CREATE TRIGGER synthetic_queue_failure BEFORE INSERT ON local_jobs BEGIN SELECT RAISE(ABORT,'Synthetic queue unavailable'); END;",
    );
    expect(() => f.ingest([first])).toThrow();
    for (const table of ['local_events', 'local_event_intakes', 'local_event_fts', 'local_jobs'])
      expect(
        database(f.store).prepare(`SELECT count(*) AS count FROM ${table}`).get()?.['count'],
      ).toBe(0);
    database(f.store).exec('DROP TRIGGER synthetic_queue_failure');
    f.ingest([first]);
    const second = f.event(2);
    expect(() =>
      f.ingest([second, { ...first, outcome: { ...first.outcome, exitCode: 0 } }]),
    ).toThrow();
    expect(
      database(f.store)
        .prepare('SELECT event_id FROM local_event_fts')
        .all()
        .map((row) => row['event_id']),
    ).toEqual([first.eventId]);
    expectNotFound(() => f.store.getMemory(f.context, second.eventId));
  });
});
