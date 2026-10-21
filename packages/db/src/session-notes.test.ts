import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvent, CreateSessionNote, SessionNotesQuery } from '@memvora/contracts';
import { DomainError, prepareEvents } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    if (!existsSync(directory)) continue;
    const target = realpathSync(resolve(directory));
    const prefix = join(temporaryRoot, 'memvora-notes-');
    if (
      target === temporaryRoot ||
      dirname(target) !== temporaryRoot ||
      !target.startsWith(prefix) ||
      !basename(target).startsWith('memvora-notes-')
    )
      throw new Error('Refusing to remove a temporary path outside this test target.');
    rmSync(target, { recursive: true, force: true });
  }
});
const open = (path = ':memory:') => {
  const store = new SqliteEvidenceStore(path);
  stores.push(store);
  return store;
};
const database = (store: SqliteEvidenceStore) =>
  (store as unknown as { database: DatabaseSync }).database;
function filePath() {
  const directory = mkdtempSync(join(temporaryRoot, 'memvora-notes-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}
function fixture(path = ':memory:') {
  const store = open(path);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Investigation journal' });
  const session = store.createSession(context, { repositoryId: repository.id });
  const event = (sequence: number, sessionId = session.id): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId,
    sequence,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'node', args: ['--version'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stdout', ordinal: 0, text: `Observed step ${sequence}` }],
    diffs: [],
  });
  const create = (body: string, extra: Partial<CreateSessionNote> = {}) =>
    store.createSessionNote(context, session.id, {
      id: randomUUID(),
      kind: 'note',
      body,
      eventIds: [],
      ...extra,
    });
  return { store, context, repository, session, event, create };
}
function code(action: () => unknown, expected: string) {
  try {
    action();
    throw new Error('Expected the operation to be rejected.');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(expected);
  }
}

describe('append-only scoped investigation notes', () => {
  it('returns the original immutable note on normalized retries and rejects changed UUID payloads or paths', () => {
    const { store, context, repository, session, event } = fixture();
    const first = event(1);
    const second = event(2);
    store.ingest(context, prepareEvents([first, second]));
    const input: CreateSessionNote = {
      id: randomUUID(),
      kind: 'decision',
      body: '  Retry the connection after checking its pool.  ',
      eventIds: [second.eventId, first.eventId],
    };
    const initial = store.createSessionNote(context, session.id, input);
    expect(initial.created).toBe(true);
    expect(initial.note).toMatchObject({
      id: input.id,
      kind: 'decision',
      body: input.body.trim(),
      author: { id: context.user.id, name: context.user.name },
      label: 'User-authored — not independently verified',
    });
    expect(initial.note.sources.map((source) => source.id)).toEqual([...input.eventIds].sort());
    const retry = store.createSessionNote(
      { ...context, user: { ...context.user, name: 'Changed local display name' } },
      session.id,
      { ...input, body: input.body.trim(), eventIds: [...input.eventIds].reverse() },
    );
    expect(retry).toEqual({ note: initial.note, created: false });
    code(
      () =>
        store.createSessionNote(context, session.id, { ...input, body: 'A different decision.' }),
      'IMMUTABLE_NOTE_CONFLICT',
    );
    code(
      () => store.createSessionNote(context, session.id, { ...input, kind: 'resolution' }),
      'IMMUTABLE_NOTE_CONFLICT',
    );
    const other = store.createSession(context, { repositoryId: repository.id });
    code(() => store.createSessionNote(context, other.id, input), 'IMMUTABLE_NOTE_CONFLICT');
    expect(store.sessionNotes(context, session.id).totalNotes).toBe(1);
    expect(() =>
      database(store)
        .prepare('UPDATE local_session_notes SET body=? WHERE id=?')
        .run('Mutated', input.id),
    ).toThrow('SESSION_NOTE_IMMUTABLE');
  });

  it('rejects a note UUID already used by an event without modifying the event or journal', () => {
    const { store, context, session, event, create } = fixture();
    const captured = event(1);
    store.ingest(context, prepareEvents([captured]));
    code(
      () => create('Cannot impersonate event evidence', { id: captured.eventId }),
      'IMMUTABLE_NOTE_CONFLICT',
    );
    expect(store.getEvent(context, captured.eventId)).toEqual(captured);
    expect(store.sessionNotes(context, session.id).totalNotes).toBe(0);
    expect(
      database(store).prepare('SELECT count(*) AS count FROM local_session_note_fts').get()?.[
        'count'
      ],
    ).toBe(0);
  });

  it('rejects note UUIDs used by current or retained historical repository-file sources', () => {
    const { store, context, repository, session, create } = fixture();
    const imported = (text: string) =>
      store.saveRepositoryContext(context, repository.id, {
        provider: 'github',
        fullName: 'owner/journal-source',
        defaultBranch: 'main',
        commitSha: null,
        importedAt: new Date().toISOString(),
        files: [{ path: 'src/index.ts', sha: 'a'.repeat(40), size: text.length, text }],
        issues: [],
        pullRequests: [],
      });
    imported('export const sourceVersion = 1;');
    const previousId = store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId!;
    imported('export const sourceVersion = 2;');
    const currentId = store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId!;
    expect(currentId).not.toBe(previousId);
    for (const id of [previousId, currentId])
      code(
        () => create('Cannot impersonate repository evidence', { id }),
        'IMMUTABLE_NOTE_CONFLICT',
      );
    expect(store.sessionNotes(context, session.id).totalNotes).toBe(0);
    expect(store.getRepositorySource(context, previousId).source.isCurrent).toBe(false);
    expect(store.getRepositorySource(context, currentId).source.isCurrent).toBe(true);
  });

  it('rolls back the entire event intake and job creation when an event UUID collides with an active note', () => {
    const { store, context, event, create } = fixture();
    const { note } = create('Preserve the authored record');
    const ordinary = event(1);
    const colliding = { ...event(2), eventId: note.id };
    code(
      () => store.ingest(context, prepareEvents([ordinary, colliding])),
      'IMMUTABLE_NOTE_CONFLICT',
    );
    code(() => store.getEvent(context, ordinary.eventId), 'NOT_FOUND');
    code(() => store.getEvent(context, colliding.eventId), 'NOT_FOUND');
    expect(store.getSessionNote(context, note.id)).toEqual(note);
    expect(store.dashboard(context).counts).toMatchObject({ events: 0, queuedJobs: 0 });
    expect(
      database(store).prepare('SELECT count(*) AS count FROM local_event_intakes').get()?.['count'],
    ).toBe(0);
    expect(store.ingest(context, prepareEvents([ordinary]))).toEqual([ordinary.eventId]);
    expect(store.dashboard(context).counts).toMatchObject({ events: 1, queuedJobs: 1 });
  });

  it('rejects event UUIDs used by current or retained file sources without accepting partial intake or jobs', () => {
    const { store, context, repository, event } = fixture();
    const imported = (text: string) =>
      store.saveRepositoryContext(context, repository.id, {
        provider: 'github',
        fullName: 'owner/citation-collision',
        defaultBranch: 'main',
        commitSha: null,
        importedAt: new Date().toISOString(),
        files: [{ path: 'src/index.ts', sha: 'a'.repeat(40), size: text.length, text }],
        issues: [],
        pullRequests: [],
      });
    imported('export const collisionVersion = 1;');
    const previousId = store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId!;
    imported('export const collisionVersion = 2;');
    const currentId = store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId!;
    const ordinary = event(1);
    for (const id of [previousId, currentId]) {
      const colliding = { ...event(2), eventId: id };
      code(
        () => store.ingest(context, prepareEvents([ordinary, colliding])),
        'IMMUTABLE_EVENT_CONFLICT',
      );
      code(() => store.getEvent(context, ordinary.eventId), 'NOT_FOUND');
      code(() => store.getEvent(context, id), 'NOT_FOUND');
      expect(store.dashboard(context).counts).toMatchObject({ events: 0, queuedJobs: 0 });
      expect(
        database(store).prepare('SELECT count(*) AS count FROM local_event_intakes').get()?.[
          'count'
        ],
      ).toBe(0);
    }
    expect(store.getRepositorySource(context, previousId).source.isCurrent).toBe(false);
    expect(store.getRepositorySource(context, currentId).source.isCurrent).toBe(true);
    expect(store.ingest(context, prepareEvents([ordinary]))).toEqual([ordinary.eventId]);
    expect(store.dashboard(context).counts).toMatchObject({ events: 1, queuedJobs: 1 });
  });

  it('normalizes controls before redaction and persists only safe body and author text in notes and search', () => {
    const { store, context, session, create } = fixture();
    const { note } = create(
      'pass\u0000word="plain secret"\nAuthorization: Bearer plaintext-token\nSafe journalNeedle',
    );
    expect(note.body).toContain('password="[REDACTED]"');
    expect(note.body).not.toContain('plain secret');
    expect(note.body).not.toContain('plaintext-token');
    expect(note.body).not.toContain('\u0000');
    const author = store.createSessionNote(
      {
        ...context,
        user: { ...context.user, name: '\u001b[31mpass\u0000word=author-secret\u001b[0m' },
      },
      session.id,
      { id: randomUUID(), kind: 'note', body: 'Safe author snapshot', eventIds: [] },
    );
    expect(author.note.author.name).toBe('password=[REDACTED]');
    const persisted = database(store)
      .prepare('SELECT body FROM local_session_notes WHERE id=?')
      .get(note.id)!['body'];
    const indexed = database(store)
      .prepare('SELECT body FROM local_session_note_fts WHERE note_id=?')
      .get(note.id)!['body'];
    expect(persisted).toBe(note.body);
    expect(indexed).toBe(note.body);
    expect(
      store.searchSessionNotes(context, { query: 'journalNeedle' }).map((item) => item.id),
    ).toEqual([note.id]);
    expect(store.searchSessionNotes(context, { query: 'plaintext-token' })).toEqual([]);
    code(() => create('\u0000\u009b\u202e \n\t'), 'INVALID_SESSION_NOTE');
    expect(store.sessionNotes(context, session.id).totalNotes).toBe(2);
  });

  it('discovers a journal-only recent investigation and ignores completely empty sessions', () => {
    const { store, context, repository, session, create } = fixture();
    expect(store.recentSession(context)).toBeNull();
    create('Stopped before collecting command evidence');
    store.createSession(context, { repositoryId: repository.id, title: 'New but empty' });
    const recent = store.recentSession(context);
    expect(recent).toMatchObject({
      session: { id: session.id, eventCount: 0 },
      events: [],
      memories: [],
    });
    expect(store.recentSession(context, [])).toBeNull();
    expect(store.recentSession(context, [repository.id])?.session.id).toBe(session.id);
    code(() => store.recentSession(context, [randomUUID()]), 'NOT_FOUND');
  });

  it('uses new journal activity on an older event session and deterministic note/ordinal timestamp ties', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
    const { store, context, repository, session, event, create } = fixture();
    store.ingest(context, prepareEvents([event(1)]));
    const other = store.createSession(context, { repositoryId: repository.id });
    vi.setSystemTime(new Date('2026-10-21T11:00:00.000Z'));
    store.ingest(context, prepareEvents([event(1, other.id)]));
    expect(store.recentSession(context)?.session.id).toBe(other.id);
    // Notes win equal timestamps over command evidence, even on an older investigation.
    create('An explicit stop point for the older investigation');
    expect(store.recentSession(context)?.session.id).toBe(session.id);
    store.createSessionNote(context, other.id, {
      id: randomUUID(),
      kind: 'note',
      body: 'A later append with the same wall-clock timestamp',
      eventIds: [],
    });
    expect(store.recentSession(context)?.session.id).toBe(other.id);
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));
    create('A genuinely newer journal update on the first session');
    expect(store.recentSession(context)?.session.id).toBe(session.id);
  });

  it('ignores inaccessible journal activity and filters recent selection to explicitly authorized repositories', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
    const { store, context, repository, session, create } = fixture();
    create('Older active investigation');
    const otherRepository = store.createRepository(context, { name: 'Separate latest repository' });
    const other = store.createSession(context, { repositoryId: otherRepository.id });
    vi.setSystemTime(new Date('2026-10-21T11:00:00.000Z'));
    store.createSessionNote(context, other.id, {
      id: randomUUID(),
      kind: 'note',
      body: 'Newer journal-only investigation',
      eventIds: [],
    });
    expect(store.recentSession(context)?.session.id).toBe(other.id);
    expect(store.recentSession(context, [repository.id])?.session.id).toBe(session.id);
    database(store)
      .prepare('UPDATE local_repositories SET generation=generation+1 WHERE id=?')
      .run(otherRepository.id);
    expect(store.recentSession(context)?.session.id).toBe(session.id);
    store.createSessionNote(context, other.id, {
      id: randomUUID(),
      kind: 'note',
      body: 'Current generation note',
      eventIds: [],
    });
    expect(store.recentSession(context)?.session.id).toBe(other.id);
    database(store)
      .prepare('UPDATE local_sessions SET generation=generation+1 WHERE id=?')
      .run(other.id);
    expect(store.recentSession(context)?.session.id).toBe(session.id);
    store.deleteSession(context, session.id);
    expect(store.recentSession(context)).toBeNull();
    store.deleteRepository(context, otherRepository.id);
    code(() => store.recentSession(context, [otherRepository.id]), 'NOT_FOUND');
    store.deleteWorkspace(context);
    code(() => store.recentSession(context), 'WORKSPACE_UNAVAILABLE');
  });

  it('rejects foreign or missing event citations atomically and binds citations to the exact session and repository', () => {
    const { store, context, repository, session, event, create } = fixture();
    const otherSession = store.createSession(context, { repositoryId: repository.id });
    const foreign = event(1, otherSession.id);
    const own = event(1);
    store.ingest(context, prepareEvents([foreign, own]));
    code(
      () => create('Unsupported source', { eventIds: [own.eventId, foreign.eventId] }),
      'NOT_FOUND',
    );
    code(() => create('Missing source', { eventIds: [randomUUID()] }), 'NOT_FOUND');
    expect(store.sessionNotes(context, session.id).totalNotes).toBe(0);
    const created = create('Source linked', { kind: 'resolution', eventIds: [own.eventId] });
    expect(created.note.sources).toEqual([
      {
        id: own.eventId,
        kind: 'event',
        repositoryId: repository.id,
        locator: `/v1/events/${own.eventId}`,
      },
    ]);
    const otherRepository = store.createRepository(context, { name: 'Other repository' });
    const repoSession = store.createSession(context, { repositoryId: otherRepository.id });
    code(
      () =>
        store.createSessionNote(context, repoSession.id, {
          id: randomUUID(),
          kind: 'note',
          body: 'Cross-repository reference',
          eventIds: [own.eventId],
        }),
      'NOT_FOUND',
    );
  });

  it('pages more than50 notes by append ordinal with no gaps while new notes arrive', () => {
    const { store, context, repository, session, create } = fixture();
    expect(store.sessionNotes(context, session.id)).toEqual({
      sessionId: session.id,
      totalNotes: 0,
      items: [],
      olderBeforeId: null,
    });
    const notes = Array.from(
      { length: 67 },
      (_value, index) => create(`Append step ${index + 1}`).note,
    );
    const latest = store.sessionNotes(context, session.id, { limit: 50 });
    expect(latest.items.map((note) => note.id)).toEqual(notes.slice(-50).map((note) => note.id));
    expect(latest.totalNotes).toBe(67);
    expect(latest.olderBeforeId).toBe(notes[17]!.id);
    const appended = create('New live append').note;
    const older = store.sessionNotes(context, session.id, {
      before: latest.olderBeforeId!,
      limit: 50,
    });
    expect(older.items.map((note) => note.id)).toEqual(notes.slice(0, 17).map((note) => note.id));
    expect(older.totalNotes).toBe(68);
    expect(older.olderBeforeId).toBeNull();
    expect(new Set([...older.items, ...latest.items].map((note) => note.id)).size).toBe(67);
    expect(store.sessionNotes(context, session.id).items.at(-1)!.id).toBe(appended.id);
    const empty = store.sessionNotes(context, session.id, { before: notes[0]!.id });
    expect(empty).toMatchObject({ totalNotes: 68, items: [], olderBeforeId: null });
    const other = store.createSession(context, { repositoryId: repository.id });
    code(
      () => store.sessionNotes(context, other.id, { before: latest.olderBeforeId! }),
      'NOT_FOUND',
    );
    for (const query of [
      { limit: 0 },
      { limit: 51 },
      { limit: '20' },
      { before: 'not-a-uuid' },
      { offset: 2 },
      Object.create({ limit: 20 }) as SessionNotesQuery,
      new Date(),
    ])
      code(
        () => store.sessionNotes(context, session.id, query as SessionNotesQuery),
        'INVALID_SESSION_NOTES_QUERY',
      );
    expect(
      store.sessionNotes(context, session.id, Object.assign(Object.create(null), { limit: 1 }))
        .items,
    ).toHaveLength(1);
  });

  it('searches literal FTS text inside authorized repository and session filters with explicit empty scope', () => {
    const { store, context, repository, session, create } = fixture();
    const first = create('Repeated noteSearchNeedle from the original investigation').note;
    const otherSession = store.createSession(context, { repositoryId: repository.id });
    const second = store.createSessionNote(context, otherSession.id, {
      id: randomUUID(),
      kind: 'decision',
      body: 'Other noteSearchNeedle in the same repository',
      eventIds: [],
    }).note;
    const otherRepository = store.createRepository(context, { name: 'Other codebase' });
    const otherRepoSession = store.createSession(context, { repositoryId: otherRepository.id });
    const third = store.createSessionNote(context, otherRepoSession.id, {
      id: randomUUID(),
      kind: 'note',
      body: 'Separate noteSearchNeedle from another codebase',
      eventIds: [],
    }).note;
    expect(
      new Set(
        store.searchSessionNotes(context, { query: 'noteSearchNeedle' }).map((note) => note.id),
      ),
    ).toEqual(new Set([first.id, second.id, third.id]));
    expect(
      new Set(
        store
          .searchSessionNotes(context, {
            query: 'noteSearchNeedle',
            repositoryIds: [repository.id],
          })
          .map((note) => note.id),
      ),
    ).toEqual(new Set([first.id, second.id]));
    expect(
      store
        .searchSessionNotes(context, { query: 'noteSearchNeedle' }, session.id)
        .map((note) => note.id),
    ).toEqual([first.id]);
    expect(
      store.searchSessionNotes(
        context,
        { query: 'noteSearchNeedle', repositoryIds: [otherRepository.id] },
        session.id,
      ),
    ).toEqual([]);
    expect(
      store.searchSessionNotes(context, { query: 'noteSearchNeedle', repositoryIds: [] }),
    ).toEqual([]);
    expect(store.searchSessionNotes(context, { query: 'noteSearchNeedle', limit: 1 })).toHaveLength(
      1,
    );
    expect(() => store.searchSessionNotes(context, { query: '" OR * : ( )' })).not.toThrow();
    code(
      () =>
        store.searchSessionNotes(context, {
          query: 'noteSearchNeedle',
          repositoryIds: [randomUUID()],
        }),
      'NOT_FOUND',
    );
    code(
      () =>
        store.searchSessionNotes(
          { ...context, user: { ...context.user, id: randomUUID() } },
          { query: 'noteSearchNeedle' },
        ),
      'WORKSPACE_UNAVAILABLE',
    );
  });

  it('never exposes a note, cursor or UUID collision from another authorized workspace', () => {
    const { store, context, create } = fixture();
    const original = create('Private workspaceIsolationNeedle').note;
    const otherContext = {
      ...context,
      user: { id: randomUUID(), name: 'Another local owner' },
      workspace: { id: randomUUID(), name: 'Another workspace', generation: 1 },
    };
    database(store)
      .prepare('INSERT INTO local_workspaces(id,owner_user_id,name,created_at) VALUES(?,?,?,?)')
      .run(
        otherContext.workspace.id,
        otherContext.user.id,
        otherContext.workspace.name,
        new Date().toISOString(),
      );
    const repository = store.createRepository(otherContext, { name: 'Separate codebase' });
    const session = store.createSession(otherContext, { repositoryId: repository.id });
    code(() => store.getSessionNote(otherContext, original.id), 'NOT_FOUND');
    code(() => store.sessionNotes(otherContext, session.id, { before: original.id }), 'NOT_FOUND');
    code(
      () =>
        store.createSessionNote(otherContext, session.id, {
          id: original.id,
          kind: original.kind,
          body: original.body,
          eventIds: [],
        }),
      'NOT_FOUND',
    );
    expect(store.searchSessionNotes(otherContext, { query: 'workspaceIsolationNeedle' })).toEqual(
      [],
    );
    expect(store.sessionNotes(otherContext, session.id).totalNotes).toBe(0);
    expect(store.getSessionNote(context, original.id)).toEqual(original);
  });

  it.each(['session', 'repository', 'workspace'] as const)(
    'fences stale %s generations across create, get, page and search',
    (scope) => {
      const { store, context, repository, session, create } = fixture();
      const note = create('Generation fenceNeedle').note;
      const table = {
        session: 'local_sessions',
        repository: 'local_repositories',
        workspace: 'local_workspaces',
      }[scope];
      const id = {
        session: session.id,
        repository: repository.id,
        workspace: context.workspace.id,
      }[scope];
      database(store).prepare(`UPDATE ${table} SET generation=generation+1 WHERE id=?`).run(id);
      if (scope === 'workspace') {
        code(() => store.getSessionNote(context, note.id), 'WORKSPACE_UNAVAILABLE');
        code(() => store.sessionNotes(context, session.id), 'WORKSPACE_UNAVAILABLE');
        code(
          () => store.searchSessionNotes(context, { query: 'fenceNeedle' }),
          'WORKSPACE_UNAVAILABLE',
        );
        code(() => create('Stale write'), 'WORKSPACE_UNAVAILABLE');
        code(() => store.recentSession(context), 'WORKSPACE_UNAVAILABLE');
      }
      const fresh = scope === 'workspace' ? store.context() : context;
      code(() => store.getSessionNote(fresh, note.id), 'NOT_FOUND');
      expect(store.sessionNotes(fresh, session.id).items).toEqual([]);
      expect(store.searchSessionNotes(fresh, { query: 'fenceNeedle' })).toEqual([]);
      expect(store.recentSession(fresh)).toBeNull();
      code(
        () =>
          store.createSessionNote(fresh, session.id, {
            id: note.id,
            kind: note.kind,
            body: note.body,
            eventIds: [],
          }),
        'NOT_FOUND',
      );
      const next = store.createSessionNote(fresh, session.id, {
        id: randomUUID(),
        kind: 'note',
        body: 'Fresh fenceNeedle',
        eventIds: [],
      });
      expect(store.getSessionNote(fresh, next.note.id)).toEqual(next.note);
      code(() => store.sessionNotes(fresh, session.id, { before: note.id }), 'NOT_FOUND');
    },
  );

  it.each(['session', 'repository', 'workspace'] as const)(
    'physically removes notes and FTS entries on %s deletion',
    (scope) => {
      const { store, context, repository, session, create } = fixture();
      const note = create('Purge journalNeedle').note;
      if (scope === 'session') store.deleteSession(context, session.id);
      else if (scope === 'repository') store.deleteRepository(context, repository.id);
      else store.deleteWorkspace(context);
      expect(
        database(store).prepare('SELECT count(*) AS count FROM local_session_notes').get()?.[
          'count'
        ],
      ).toBe(0);
      expect(
        database(store).prepare('SELECT count(*) AS count FROM local_session_note_fts').get()?.[
          'count'
        ],
      ).toBe(0);
      code(
        () => store.getSessionNote(context, note.id),
        scope === 'workspace' ? 'WORKSPACE_UNAVAILABLE' : 'NOT_FOUND',
      );
      code(
        () => create('No resurrection'),
        scope === 'workspace' ? 'WORKSPACE_UNAVAILABLE' : 'NOT_FOUND',
      );
      if (scope !== 'workspace')
        expect(store.searchSessionNotes(context, { query: 'journalNeedle' })).toEqual([]);
    },
  );

  it('preserves existing evidence through schema6 migration and keeps notes/FTS/retries stable after restart', () => {
    const { store, context, repository, session, event } = fixture(filePath());
    const captured = event(1);
    store.ingest(context, prepareEvents([captured]));
    database(store).exec(
      'DROP TRIGGER local_session_note_immutable; DROP TRIGGER local_session_note_fts_insert; DROP TRIGGER local_session_note_fts_delete; DROP TABLE local_session_note_fts; DROP TABLE local_session_notes; PRAGMA user_version=6',
    );
    store.close();
    const upgraded = open(store.path);
    expect(upgraded.context()).toEqual(context);
    expect(upgraded.getEvent(context, captured.eventId)).toEqual(captured);
    expect(upgraded.getRepository(context, repository.id).name).toBe(repository.name);
    const input: CreateSessionNote = {
      id: randomUUID(),
      kind: 'decision',
      body: 'Persistent restartNeedle',
      eventIds: [captured.eventId],
    };
    const saved = upgraded.createSessionNote(context, session.id, input);
    database(upgraded).exec('PRAGMA user_version=6');
    upgraded.close();
    const reopened = open(store.path);
    expect(database(reopened).prepare('PRAGMA user_version').get()?.['user_version']).toBe(8);
    expect(reopened.getSessionNote(context, input.id)).toEqual(saved.note);
    expect(reopened.createSessionNote(context, session.id, input)).toEqual({
      note: saved.note,
      created: false,
    });
    expect(
      reopened.searchSessionNotes(context, { query: 'restartNeedle' }).map((note) => note.id),
    ).toEqual([input.id]);
    expect(
      database(reopened).prepare('SELECT count(*) AS count FROM local_session_note_fts').get()?.[
        'count'
      ],
    ).toBe(1);
  });
});
