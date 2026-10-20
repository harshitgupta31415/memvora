import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent, SessionEventsQuery } from '@memvora/contracts';
import { deriveObservedMemory, DomainError, prepareEvents } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    if (!existsSync(directory)) continue;
    const target = realpathSync(resolve(directory));
    const prefix = join(temporaryRoot, 'memvora-history-');
    if (
      target === temporaryRoot ||
      dirname(target) !== temporaryRoot ||
      !target.startsWith(prefix) ||
      !basename(target).startsWith('memvora-history-')
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
function filePath() {
  const directory = mkdtempSync(join(temporaryRoot, 'memvora-history-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}
function fixture(path = ':memory:') {
  const store = open(path);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Paged history' });
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
    output: [{ stream: 'stdout', ordinal: 0, text: `Observed sequence ${sequence}` }],
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

describe('durable snapshot session history', () => {
  it('uses actual sparse sequence boundaries in both directions and returns only page memories', () => {
    const { store, context, session, event, ingest } = fixture();
    const sequences = Array.from({ length: 11 }, (_value, index) => (index + 1) * 2);
    ingest(sequences.map((sequence) => event(sequence)));
    for (let job = store.claimJob(); job; job = store.claimJob())
      store.completeJob(job, deriveObservedMemory(job.event));
    const latest = store.getSessionEvents(context, session.id, { limit: 4 });
    expect(latest.events.map((captured) => captured.sequence)).toEqual([16, 18, 20, 22]);
    expect(latest.memories.map((memory) => memory.id)).toEqual(
      latest.events.map((captured) => captured.eventId),
    );
    expect(latest.page).toMatchObject({
      snapshotEventCount: 11,
      returnedEvents: 4,
      firstSequence: 16,
      lastSequence: 22,
      newerCursor: null,
    });
    const middle = store.getSessionEvents(context, session.id, {
      limit: 4,
      cursor: latest.page.olderCursor!,
    });
    const oldest = store.getSessionEvents(context, session.id, {
      limit: 4,
      cursor: middle.page.olderCursor!,
    });
    expect(oldest.events.map((captured) => captured.sequence)).toEqual([2, 4, 6]);
    expect(oldest.page.olderCursor).toBeNull();
    expect(
      [...oldest.events, ...middle.events, ...latest.events].map((captured) => captured.sequence),
    ).toEqual(sequences);
    const forward = store.getSessionEvents(context, session.id, {
      limit: 4,
      cursor: oldest.page.newerCursor!,
    });
    expect(forward.events.map((captured) => captured.sequence)).toEqual(
      middle.events.map((captured) => captured.sequence),
    );
    expect(
      store
        .getSessionEvents(context, session.id, { limit: 4, cursor: forward.page.newerCursor! })
        .events.map((captured) => captured.sequence),
    ).toEqual(latest.events.map((captured) => captured.sequence));
  });

  it('keeps fixed intake membership despite lower-sequence arrivals and never reuses a deleted intake number', () => {
    const { store, context, repository, session, event, ingest } = fixture(filePath());
    ingest([2, 3, 4, 5, 6].map((sequence) => event(sequence)));
    const latest = store.getSessionEvents(context, session.id, { limit: 2 });
    const otherSession = store.createSession(context, { repositoryId: repository.id });
    const otherEvent = event(1, otherSession.id);
    ingest([otherEvent]);
    const connection = new DatabaseSync(store.path);
    let deletedIntake: number;
    try {
      deletedIntake = Number(
        connection
          .prepare('SELECT id FROM local_event_intakes WHERE event_id=?')
          .get(otherEvent.eventId)?.['id'],
      );
    } finally {
      connection.close();
    }
    store.deleteSession(context, otherSession.id);
    const late = event(1);
    const appended = event(7);
    ingest([late, appended]);
    const reopenedConnection = new DatabaseSync(store.path);
    try {
      expect(
        Number(
          reopenedConnection
            .prepare('SELECT id FROM local_event_intakes WHERE event_id=?')
            .get(late.eventId)?.['id'],
        ),
      ).toBeGreaterThan(deletedIntake!);
    } finally {
      reopenedConnection.close();
    }
    const middle = store.getSessionEvents(context, session.id, {
      limit: 2,
      cursor: latest.page.olderCursor!,
    });
    const oldest = store.getSessionEvents(context, session.id, {
      limit: 2,
      cursor: middle.page.olderCursor!,
    });
    expect(
      [...oldest.events, ...middle.events, ...latest.events].map((captured) => captured.sequence),
    ).toEqual([2, 3, 4, 5, 6]);
    expect(oldest.page.snapshotEventCount).toBe(5);
    expect(oldest.session.eventCount).toBe(7);
    expect(store.getSessionEvents(context, session.id, { limit: 2 }).page.snapshotEventCount).toBe(
      7,
    );
  });

  it('rejects nonHTTP query violations, noncanonical tokens, modified signatures and signed unsafe boundaries', () => {
    const { store, context, session, event, ingest } = fixture(filePath());
    ingest([1, 2, 3].map((sequence) => event(sequence)));
    const cursor = store.getSessionEvents(context, session.id, { limit: 1 }).page.olderCursor!;
    for (const value of [0, -1, 51, 1.5, Number.MAX_SAFE_INTEGER + 1, '20', null])
      code(
        () =>
          store.getSessionEvents(context, session.id, {
            limit: value,
          } as unknown as SessionEventsQuery),
        'INVALID_HISTORY_QUERY',
      );
    code(
      () =>
        store.getSessionEvents(context, session.id, {
          extra: true,
        } as unknown as SessionEventsQuery),
      'INVALID_HISTORY_QUERY',
    );
    for (const value of [
      '',
      `${cursor}=`,
      'not-a-cursor',
      'a'.repeat(2049),
      `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`,
    ])
      code(() => store.getSessionEvents(context, session.id, { cursor: value }), 'INVALID_CURSOR');
    const [body] = cursor.split('.');
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const connection = new DatabaseSync(store.path);
    let secret: Buffer;
    try {
      secret = Buffer.from(
        String(
          connection
            .prepare('SELECT cursor_secret FROM local_history_state WHERE singleton=1')
            .get()?.['cursor_secret'],
        ),
        'hex',
      );
    } finally {
      connection.close();
    }
    const signed = (changes: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify({ ...decoded, ...changes })).toString('base64url');
      return `${encoded}.${createHmac('sha256', secret!).update(encoded).digest('base64url')}`;
    };
    for (const changes of [
      { version: 2 },
      { boundary: Number.MAX_SAFE_INTEGER + 1 },
      { watermark: 0 },
      { snapshotEventCount: 99 },
      { userId: randomUUID() },
      { extra: true },
    ])
      code(
        () => store.getSessionEvents(context, session.id, { cursor: signed(changes) }),
        'INVALID_CURSOR',
      );
    expect(() => ingest([event(Number.MAX_SAFE_INTEGER + 1)])).toThrow();
  });

  it('revalidates session, principal and all live generations before accepting a prior cursor', () => {
    const { store, context, repository, session, event, ingest } = fixture(filePath());
    ingest([1, 2, 3].map((sequence) => event(sequence)));
    const cursor = store.getSessionEvents(context, session.id, { limit: 1 }).page.olderCursor!;
    const otherSession = store.createSession(context, { repositoryId: repository.id });
    code(() => store.getSessionEvents(context, otherSession.id, { cursor }), 'INVALID_CURSOR');
    code(
      () =>
        store.getSessionEvents(
          { ...context, user: { ...context.user, id: randomUUID() } },
          session.id,
          { cursor },
        ),
      'WORKSPACE_UNAVAILABLE',
    );
    const connection = new DatabaseSync(store.path);
    try {
      connection
        .prepare('UPDATE local_repositories SET generation=generation+1 WHERE id=?')
        .run(repository.id);
    } finally {
      connection.close();
    }
    code(() => store.getSessionEvents(context, session.id, { cursor }), 'INVALID_CURSOR');
    const renewed = store.getSessionEvents(context, session.id, { limit: 1 }).page.olderCursor!;
    const sessionConnection = new DatabaseSync(store.path);
    try {
      sessionConnection
        .prepare('UPDATE local_sessions SET generation=generation+1 WHERE id=?')
        .run(session.id);
    } finally {
      sessionConnection.close();
    }
    code(() => store.getSessionEvents(context, session.id, { cursor: renewed }), 'INVALID_CURSOR');
    const latest = store.getSessionEvents(context, session.id, { limit: 1 }).page.olderCursor!;
    const workspaceConnection = new DatabaseSync(store.path);
    try {
      workspaceConnection
        .prepare('UPDATE local_workspaces SET generation=generation+1 WHERE id=?')
        .run(context.workspace.id);
    } finally {
      workspaceConnection.close();
    }
    code(
      () => store.getSessionEvents(context, session.id, { cursor: latest }),
      'WORKSPACE_UNAVAILABLE',
    );
    const freshContext = store.context();
    code(
      () => store.getSessionEvents(freshContext, session.id, { cursor: latest }),
      'INVALID_CURSOR',
    );
    const freshCursor = store.getSessionEvents(freshContext, session.id, { limit: 1 }).page
      .olderCursor!;
    store.deleteSession(freshContext, session.id);
    code(
      () => store.getSessionEvents(freshContext, session.id, { cursor: freshCursor }),
      'NOT_FOUND',
    );
  });

  it('returns an honest empty page without fabricated sequence boundaries or cursors', () => {
    const { store, context, session } = fixture();
    expect(store.getSessionEvents(context, session.id)).toMatchObject({
      events: [],
      memories: [],
      page: {
        snapshotEventCount: 0,
        returnedEvents: 0,
        firstSequence: null,
        lastSequence: null,
        olderCursor: null,
        newerCursor: null,
      },
    });
  });

  it('backfills version-4 intake once and preserves cursor membership and signatures across restart', () => {
    const path = filePath();
    const previous = fixture(path);
    previous.ingest([2, 3, 4, 5].map((sequence) => previous.event(sequence)));
    previous.store.close();
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(
        'BEGIN IMMEDIATE; DROP TABLE local_event_intakes; DROP TABLE local_history_state; PRAGMA user_version=4; COMMIT;',
      );
    } finally {
      legacy.close();
    }
    const upgraded = open(path);
    const context = upgraded.context();
    const latest = upgraded.getSessionEvents(context, previous.session.id, { limit: 2 });
    expect(latest.page.snapshotEventCount).toBe(4);
    const cursor = latest.page.olderCursor!;
    upgraded.close();
    const reopened = open(path);
    const freshContext = reopened.context();
    reopened.ingest(freshContext, prepareEvents([previous.event(1), previous.event(6)]));
    const older = reopened.getSessionEvents(freshContext, previous.session.id, {
      limit: 2,
      cursor,
    });
    expect(older.events.map((captured) => captured.sequence)).toEqual([2, 3]);
    expect(older.page.snapshotEventCount).toBe(4);
    expect(
      reopened
        .getSessionEvents(freshContext, previous.session.id, {
          limit: 2,
          cursor: older.page.newerCursor!,
        })
        .events.map((captured) => captured.sequence),
    ).toEqual([4, 5]);
  });
});
