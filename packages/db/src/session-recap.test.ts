import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { DomainError, prepareEvents } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new SqliteEvidenceStore(':memory:');
  stores.push(store);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Investigation recap' });
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
  return { store, context, repository, session, event, ingest };
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

describe('bounded session recap evidence snapshot', () => {
  it('returns an honest empty snapshot and every event through the 40-event boundary', () => {
    const { store, context, session, event, ingest } = fixture();
    expect(store.getSessionRecapEvidence(context, session.id)).toMatchObject({
      session: { id: session.id, eventCount: 0 },
      events: [],
      totalEventCount: 0,
    });
    const events = Array.from({ length: 40 }, (_value, index) => event((index + 1) * 3));
    ingest([...events].reverse());
    const snapshot = store.getSessionRecapEvidence(context, session.id);
    expect(snapshot.totalEventCount).toBe(40);
    expect(snapshot.session.eventCount).toBe(40);
    expect(snapshot.events.map((captured) => captured.eventId)).toEqual(
      events.map((captured) => captured.eventId),
    );
    expect(store.dashboard(context).counts).toMatchObject({
      events: 40,
      memories: 0,
      queuedJobs: 40,
    });
  });

  it('selects first20 and last20 at 41 events without duplication and includes closed investigations', () => {
    const { store, context, session, event, ingest } = fixture();
    ingest(Array.from({ length: 41 }, (_value, index) => event(index + 1)).reverse());
    store.closeSession(context, session.id);
    const snapshot = store.getSessionRecapEvidence(context, session.id);
    expect(snapshot.session).toMatchObject({ status: 'closed', eventCount: 41 });
    expect(snapshot.totalEventCount).toBe(41);
    const sequences = snapshot.events.map((captured) => captured.sequence);
    expect(sequences).toEqual([
      ...Array.from({ length: 20 }, (_value, index) => index + 1),
      ...Array.from({ length: 20 }, (_value, index) => index + 22),
    ]);
    expect(new Set(snapshot.events.map((captured) => captured.eventId)).size).toBe(40);
  });

  it('keeps larger sparse out-of-order histories bounded, deterministic and isolated to the chosen session', () => {
    const { store, context, repository, session, event, ingest } = fixture();
    const sequences = Array.from({ length: 237 }, (_value, index) => (index + 1) * 13);
    const events = sequences.map((sequence) => event(sequence));
    const otherSession = store.createSession(context, { repositoryId: repository.id });
    ingest(events.filter((_event, index) => index % 2 === 0).reverse());
    ingest(events.filter((_event, index) => index % 2 === 1));
    ingest([event(1, otherSession.id), event(10_000, otherSession.id)]);
    const snapshot = store.getSessionRecapEvidence(context, session.id);
    expect(snapshot.totalEventCount).toBe(237);
    expect(snapshot.session.eventCount).toBe(237);
    expect(snapshot.events.map((captured) => captured.sequence)).toEqual([
      ...sequences.slice(0, 20),
      ...sequences.slice(-20),
    ]);
    expect(snapshot.events.every((captured) => captured.sessionId === session.id)).toBe(true);
    expect(new Set(snapshot.events.map((captured) => captured.eventId)).size).toBe(40);
    expect(store.getSessionRecapEvidence(context, session.id)).toEqual(snapshot);
    const late = event(2);
    ingest([late]);
    const updated = store.getSessionRecapEvidence(context, session.id);
    expect(updated.totalEventCount).toBe(238);
    expect(updated.events).toHaveLength(40);
    expect(updated.events[0]!.eventId).toBe(late.eventId);
    expect(snapshot.totalEventCount).toBe(237);
    expect(snapshot.events.some((captured) => captured.eventId === late.eventId)).toBe(false);
  });

  it('denies unknown sessions and forged owner, workspace or stale generation context', () => {
    const { store, context, session, event, ingest } = fixture();
    ingest([event(1)]);
    code(() => store.getSessionRecapEvidence(context, randomUUID()), 'NOT_FOUND');
    code(
      () =>
        store.getSessionRecapEvidence(
          { ...context, user: { ...context.user, id: randomUUID() } },
          session.id,
        ),
      'WORKSPACE_UNAVAILABLE',
    );
    code(
      () =>
        store.getSessionRecapEvidence(
          { ...context, workspace: { ...context.workspace, id: randomUUID() } },
          session.id,
        ),
      'WORKSPACE_UNAVAILABLE',
    );
    code(
      () =>
        store.getSessionRecapEvidence(
          {
            ...context,
            workspace: { ...context.workspace, generation: context.workspace.generation + 1 },
          },
          session.id,
        ),
      'WORKSPACE_UNAVAILABLE',
    );
    expect(store.getSessionRecapEvidence(context, session.id).totalEventCount).toBe(1);
  });

  it.each(['session', 'repository', 'workspace'] as const)(
    'rejects recap reads after deleting the authorized %s',
    (scope) => {
      const { store, context, repository, session, event, ingest } = fixture();
      ingest([event(1)]);
      if (scope === 'session') store.deleteSession(context, session.id);
      else if (scope === 'repository') store.deleteRepository(context, repository.id);
      else store.deleteWorkspace(context);
      code(
        () => store.getSessionRecapEvidence(context, session.id),
        scope === 'workspace' ? 'WORKSPACE_UNAVAILABLE' : 'NOT_FOUND',
      );
    },
  );
});
