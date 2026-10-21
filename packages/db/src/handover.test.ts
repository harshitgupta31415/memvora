import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent, CreateSessionNote } from '@memvora/contracts';
import { DomainError, prepareEvents } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const database = (store: SqliteEvidenceStore) =>
  (store as unknown as { database: DatabaseSync }).database;
function fixture() {
  const store = new SqliteEvidenceStore(':memory:');
  stores.push(store);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Handover evidence' });
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
  const ingest = (events: CapturedEvent[]) => {
    for (let offset = 0; offset < events.length; offset += 50)
      store.ingest(context, prepareEvents(events.slice(offset, offset + 50)));
  };
  const note = (body: string, eventIds: string[] = [], extra: Partial<CreateSessionNote> = {}) =>
    store.createSessionNote(context, session.id, {
      id: randomUUID(),
      kind: 'note',
      body,
      eventIds,
      ...extra,
    }).note;
  return { store, context, repository, session, event, ingest, note };
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

describe('authorized portable handover evidence snapshot', () => {
  it('returns honest empty or note-only evidence and never consumes enrichment jobs or writes records', () => {
    const { store, context, repository, session, event, ingest, note } = fixture();
    const empty = store.getSessionHandoverEvidence(context, session.id);
    expect(empty).toMatchObject({
      repository,
      recapEvidence: { session: { id: session.id, eventCount: 0 }, events: [], totalEventCount: 0 },
      notes: [],
      totalNoteCount: 0,
      events: [],
      totalEventCount: 0,
    });
    const authored = note('Stopped before running the verification command.');
    const beforeNoteRead = Number(
      database(store).prepare('SELECT total_changes() AS count').get()?.['count'],
    );
    const noteOnly = store.getSessionHandoverEvidence(context, session.id);
    expect(noteOnly).toMatchObject({
      notes: [authored],
      totalNoteCount: 1,
      totalEventCount: 0,
      events: [],
    });
    expect(
      Number(database(store).prepare('SELECT total_changes() AS count').get()?.['count']),
    ).toBe(beforeNoteRead);
    ingest([event(1)]);
    const before = store.dashboard(context).counts;
    const changes = Number(
      database(store).prepare('SELECT total_changes() AS count').get()?.['count'],
    );
    store.getSessionHandoverEvidence(context, session.id);
    expect(store.dashboard(context).counts).toEqual(before);
    expect(
      Number(database(store).prepare('SELECT total_changes() AS count').get()?.['count']),
    ).toBe(changes);
    expect(store.jobs(context)[0]!.status).toBe('queued');
  });

  it('keeps first/last recap samples while adding original payloads for every selected note citation, deduplicated in sequence order', () => {
    const { store, context, session, event, ingest, note } = fixture();
    const all = Array.from({ length: 200 }, (_value, index) => event((index + 1) * 7));
    ingest([...all].reverse());
    const notes = Array.from({ length: 12 }, (_value, index) => {
      const citations =
        index < 2
          ? [all[149 + index]!.eventId]
          : [all[index + 30]!.eventId, all[34]!.eventId, all[0]!.eventId];
      return note(`Handover note ${index + 1}`, [...new Set(citations)]);
    });
    const snapshot = store.getSessionHandoverEvidence(context, session.id);
    expect(snapshot.totalEventCount).toBe(200);
    expect(snapshot.recapEvidence.totalEventCount).toBe(200);
    expect(snapshot.recapEvidence.events.map((captured) => captured.sequence)).toEqual(
      [...all.slice(0, 20), ...all.slice(-20)].map((captured) => captured.sequence),
    );
    expect(snapshot.totalNoteCount).toBe(12);
    expect(snapshot.notes.map((authored) => authored.id)).toEqual(
      notes.slice(-10).map((authored) => authored.id),
    );
    const expectedIds = new Set([
      ...all.slice(0, 20).map((captured) => captured.eventId),
      ...all.slice(-20).map((captured) => captured.eventId),
      ...notes.slice(-10).flatMap((authored) => authored.sources.map((source) => source.id)),
    ]);
    expect(snapshot.events).toEqual(all.filter((captured) => expectedIds.has(captured.eventId)));
    expect(new Set(snapshot.events.map((captured) => captured.eventId)).size).toBe(
      snapshot.events.length,
    );
    expect(snapshot.events.every((captured) => captured.sessionId === session.id)).toBe(true);
    expect(snapshot.events.some((captured) => captured.eventId === all[149]!.eventId)).toBe(false);
    expect(snapshot.events.some((captured) => captured.eventId === all[150]!.eventId)).toBe(false);
  });

  it('includes the full140-event bound when ten notes each cite ten distinct events omitted from recap', () => {
    const { store, context, session, event, ingest, note } = fixture();
    const events = Array.from({ length: 180 }, (_value, index) => event(index + 1));
    ingest(events);
    for (let index = 0; index < 10; index++)
      note(
        `Evidence group ${index + 1}`,
        events.slice(20 + index * 10, 30 + index * 10).map((captured) => captured.eventId),
      );
    const snapshot = store.getSessionHandoverEvidence(context, session.id);
    expect(snapshot.events).toHaveLength(140);
    expect(snapshot.totalEventCount).toBe(180);
    expect(snapshot.events.map((captured) => captured.sequence)).toEqual([
      ...Array.from({ length: 120 }, (_value, index) => index + 1),
      ...Array.from({ length: 20 }, (_value, index) => index + 161),
    ]);
  });

  it('denies unknown sessions, forged owners/workspaces and stale workspace contexts', () => {
    const { store, context, session, note } = fixture();
    note('Private authored statement');
    code(() => store.getSessionHandoverEvidence(context, randomUUID()), 'NOT_FOUND');
    code(
      () =>
        store.getSessionHandoverEvidence(
          { ...context, user: { ...context.user, id: randomUUID() } },
          session.id,
        ),
      'WORKSPACE_UNAVAILABLE',
    );
    code(
      () =>
        store.getSessionHandoverEvidence(
          { ...context, workspace: { ...context.workspace, id: randomUUID() } },
          session.id,
        ),
      'WORKSPACE_UNAVAILABLE',
    );
    database(store)
      .prepare('UPDATE local_workspaces SET generation=generation+1 WHERE id=?')
      .run(context.workspace.id);
    code(() => store.getSessionHandoverEvidence(context, session.id), 'WORKSPACE_UNAVAILABLE');
    expect(store.getSessionHandoverEvidence(store.context(), session.id).notes).toEqual([]);
  });

  it.each(['session', 'repository'] as const)(
    'excludes notes from a stale %s generation',
    (scope) => {
      const { store, context, repository, session, note } = fixture();
      note('Old access generation');
      const table = scope === 'session' ? 'local_sessions' : 'local_repositories';
      database(store)
        .prepare(`UPDATE ${table} SET generation=generation+1 WHERE id=?`)
        .run(scope === 'session' ? session.id : repository.id);
      const snapshot = store.getSessionHandoverEvidence(context, session.id);
      expect(snapshot.notes).toEqual([]);
      expect(snapshot.totalNoteCount).toBe(0);
    },
  );

  it.each(['session', 'repository', 'workspace'] as const)(
    'rejects handover reads after deleting the %s',
    (scope) => {
      const { store, context, repository, session, event, ingest, note } = fixture();
      const captured = event(1);
      ingest([captured]);
      note('Deleted context', [captured.eventId]);
      if (scope === 'session') store.deleteSession(context, session.id);
      else if (scope === 'repository') store.deleteRepository(context, repository.id);
      else store.deleteWorkspace(context);
      code(
        () => store.getSessionHandoverEvidence(context, session.id),
        scope === 'workspace' ? 'WORKSPACE_UNAVAILABLE' : 'NOT_FOUND',
      );
    },
  );

  it('fails closed if stored note references become missing or point to another investigation', () => {
    const { store, context, repository, session, event, ingest, note } = fixture();
    const own = event(1);
    ingest([own]);
    const authored = note('A linked authored claim', [own.eventId]);
    database(store).prepare('DELETE FROM local_events WHERE id=?').run(own.eventId);
    code(() => store.getSessionHandoverEvidence(context, session.id), 'INVALID_HANDOVER_EVIDENCE');
    const other = store.createSession(context, { repositoryId: repository.id });
    const foreign = event(1, other.id);
    ingest([foreign]);
    database(store).exec('DROP TRIGGER local_session_note_immutable');
    database(store)
      .prepare('UPDATE local_session_notes SET event_ids_json=? WHERE id=?')
      .run(JSON.stringify([foreign.eventId]), authored.id);
    code(() => store.getSessionHandoverEvidence(context, session.id), 'INVALID_HANDOVER_EVIDENCE');
    expect(store.getEvent(context, foreign.eventId).sessionId).toBe(other.id);
  });
});
