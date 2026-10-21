import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent, SessionDirectoryRequest } from '@memvora/contracts';
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
    const prefix = join(temporaryRoot, 'memvora-directory-');
    if (
      target === temporaryRoot ||
      dirname(target) !== temporaryRoot ||
      !target.startsWith(prefix) ||
      !basename(target).startsWith('memvora-directory-')
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
  const directory = mkdtempSync(join(temporaryRoot, 'memvora-directory-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}
function fixture(path = ':memory:') {
  const store = open(path);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Directory repository' });
  const create = (
    title: string,
    repositoryId = repository.id,
    createdAt = '2026-10-21T10:00:00.000Z',
  ) => {
    const session = store.createSession(context, { repositoryId, title });
    database(store)
      .prepare('UPDATE local_sessions SET created_at=? WHERE id=?')
      .run(createdAt, session.id);
    return { ...session, createdAt };
  };
  const event = (sessionId: string, sequence: number): CapturedEvent => ({
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
    output: [{ stream: 'stdout', ordinal: 0, text: 'Observed directory test' }],
    diffs: [],
  });
  return { store, context, repository, create, event };
}
function code(action: () => unknown, expected: string) {
  try {
    action();
    throw new Error('Expected rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(expected);
  }
}

describe('scoped live investigation directory', () => {
  it('filters before global limits and counts, supports literal punctuation and Unicode NFC case matching', () => {
    const { store, context, create } = fixture();
    const older = create('An old distinctiveTitleNeedle', undefined, '2000-01-01T00:00:00.000Z');
    for (let index = 0; index < 131; index++) create(`Later investigation ${index}`);
    expect(store.sessions(context).some((session) => session.id === older.id)).toBe(false);
    const oldMatch = store.findSessions(context, { query: '  distinctivetitleneedle  ' });
    expect(oldMatch.items.map((session) => session.id)).toEqual([older.id]);
    expect(oldMatch.page).toMatchObject({
      totalMatching: 1,
      returnedItems: 1,
      consistency: 'live',
      order: 'newest_created_first',
    });
    expect(oldMatch.filters.query).toBe('distinctivetitleneedle');
    const literal = create('Café pipeline 100%_ "quoted" Échec');
    create('Cafe pipeline 100ab quoted');
    for (const query of ['CAFE\u0301', '%_', '"quoted"', 'e\u0301CHEC'])
      expect(store.findSessions(context, { query }).items.map((session) => session.id)).toEqual([
        literal.id,
      ]);
    expect(store.findSessions(context, { query: '%_not-present' }).page.totalMatching).toBe(0);
  });

  it('traverses over125 tied creation timestamps without duplication and permits changing page size', () => {
    const { store, context, create } = fixture();
    const sessions = Array.from({ length: 131 }, (_value, index) =>
      create(`Tied session ${index}`),
    );
    const expected = sessions
      .map((session) => session.id)
      .sort()
      .reverse();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = store.findSessions(context, {
        limit: cursor ? 17 : 50,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.page.totalMatching).toBe(131);
      expect(page.page.returnedItems).toBe(page.items.length);
      expect(page.items.length).toBeLessThanOrEqual(page.page.limit);
      seen.push(...page.items.map((session) => session.id));
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(131);
    const before = Number(
      database(store).prepare('SELECT total_changes() AS count').get()?.['count'],
    );
    store.findSessions(context);
    expect(
      Number(database(store).prepare('SELECT total_changes() AS count').get()?.['count']),
    ).toBe(before);
  });

  it('continues after a deleted anchor and excludes later-created appends from older pages', () => {
    const { store, context, create } = fixture();
    const ordered = Array.from({ length: 70 }, (_value, index) => create(`Live session ${index}`))
      .map((session) => session.id)
      .sort()
      .reverse();
    const first = store.findSessions(context, { limit: 25 });
    const anchor = first.items.at(-1)!.id;
    store.deleteSession(context, anchor);
    const appended = create('Newer appended investigation', undefined, '2099-01-01T00:00:00.000Z');
    const second = store.findSessions(context, { limit: 50, cursor: first.page.nextCursor! });
    expect(second.items.map((session) => session.id)).toEqual(ordered.slice(25));
    expect(second.items.some((session) => session.id === appended.id)).toBe(false);
    expect(second.page.totalMatching).toBe(70);
    expect(second.page.nextCursor).toBeNull();
    expect(store.findSessions(context).items[0]!.id).toBe(appended.id);
  });

  it('filters repository/state before counts and returns current aggregates only for selected sessions', () => {
    const { store, context, repository, create, event } = fixture();
    const open = create('Directory common open');
    const closed = create('Directory common closed');
    store.closeSession(context, closed.id);
    const captured = event(closed.id, 1);
    store.ingest(context, prepareEvents([captured]));
    const job = store.claimJob()!;
    store.completeJob(job, deriveObservedMemory(job.event));
    const otherRepository = store.createRepository(context, { name: 'Another repository' });
    create('Directory common separate', otherRepository.id);
    const page = store.findSessions(context, {
      query: 'common',
      repositoryId: repository.id,
      status: 'closed',
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: closed.id,
      status: 'closed',
      eventCount: 1,
      memoryCount: 1,
      titleTruncated: false,
    });
    expect(page.filters).toEqual({
      query: 'common',
      repositoryId: repository.id,
      status: 'closed',
    });
    expect(page.page.totalMatching).toBe(1);
    expect(
      store
        .findSessions(context, { status: 'open', repositoryId: repository.id })
        .items.map((session) => session.id),
    ).toEqual([open.id]);
  });

  it('searches the full redaction-expanded stored title while marking a Unicode-safe bounded display title', () => {
    const { store, context, create } = fixture();
    const title = `${'token=x; '.repeat(20)}endingSearchNeedle`;
    expect(title.length).toBeLessThanOrEqual(200);
    const expanded = create(title);
    expect(expanded.title.length).toBeGreaterThan(200);
    const page = store.findSessions(context, { query: 'endingSearchNeedle' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(expanded.id);
    expect(page.items[0]!.titleTruncated).toBe(true);
    expect(page.items[0]!.title.length).toBeLessThanOrEqual(200);
    expect(page.items[0]!.title).not.toContain('endingSearchNeedle');
    const unicode = create(`${'x'.repeat(199)}😀`);
    const selected = store
      .findSessions(context, { query: '😀' })
      .items.find((item) => item.id === unicode.id)!;
    expect(selected.title.length).toBe(199);
    expect(selected.titleTruncated).toBe(true);
    expect(/[\uD800-\uDBFF]$/u.test(selected.title)).toBe(false);
  });

  it('binds cursor filters and rejects tampering, malformed payloads, unrelated history cursors and wrong purposes', () => {
    const { store, context, repository, create, event } = fixture();
    const sessions = [create('Private-query-needle one'), create('Private-query-needle two')];
    const request = {
      query: 'Private-query-needle',
      repositoryId: repository.id,
      status: 'open' as const,
      limit: 1,
    };
    const cursor = store.findSessions(context, request).page.nextCursor!;
    const payload = JSON.parse(
      Buffer.from(cursor.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain(request.query);
    const secret = Buffer.from(
      String(
        database(store)
          .prepare('SELECT cursor_secret FROM local_history_state WHERE singleton=1')
          .get()?.['cursor_secret'],
      ),
      'hex',
    );
    const key = createHmac('sha256', secret).update('memvora:session-directory:v1').digest();
    const sign = (value: Record<string, unknown>, signingKey = key) => {
      const body = Buffer.from(JSON.stringify(value)).toString('base64url');
      return `d1.${body}.${createHmac('sha256', signingKey).update(`d1.${body}`).digest('base64url')}`;
    };
    const boundary = payload['boundary'] as Record<string, unknown>;
    const invalid = [
      `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`,
      cursor.replace('d1.', 'd2.'),
      `${cursor}=`,
      'x'.repeat(2048),
      sign({ ...payload, unexpected: true }),
      sign({ ...payload, version: 2 }),
      sign({ ...payload, workspaceGeneration: 1.5 }),
      sign({ ...payload, userId: 'not-a-uuid' }),
      sign({ ...payload, repositoryGeneration: null }),
      sign({ ...payload, queryHash: 'raw-query' }),
      sign({ ...payload, boundary: { ...boundary, extra: 1 } }),
      sign({ ...payload, boundary: { ...boundary, id: 'not-a-uuid' } }),
      sign({ ...payload, boundary: { ...boundary, createdAt: '2026-02-31T00:00:00.000Z' } }),
      sign(payload, secret),
    ];
    for (const candidate of invalid)
      code(() => store.findSessions(context, { ...request, cursor: candidate }), 'INVALID_CURSOR');
    code(
      () => store.findSessions(context, { ...request, query: 'changed', cursor }),
      'INVALID_CURSOR',
    );
    code(
      () => store.findSessions(context, { ...request, status: 'closed', cursor }),
      'INVALID_CURSOR',
    );
    const other = store.createRepository(context, { name: 'Changed repository' });
    code(
      () => store.findSessions(context, { ...request, repositoryId: other.id, cursor }),
      'INVALID_CURSOR',
    );
    expect(
      store.findSessions(context, { ...request, query: 'private-QUERY-needle', cursor }).items,
    ).toHaveLength(1);
    store.ingest(context, prepareEvents([event(sessions[0]!.id, 1), event(sessions[0]!.id, 2)]));
    const history = store.getSessionEvents(context, sessions[0]!.id, { limit: 1 }).page
      .olderCursor!;
    code(() => store.findSessions(context, { ...request, cursor: history }), 'INVALID_CURSOR');
    code(() => store.getSessionEvents(context, sessions[0]!.id, { cursor }), 'INVALID_CURSOR');
  });

  it('revalidates scoped parents and generations on every cursor read without leaking other workspaces', () => {
    const { store, context, repository, create } = fixture();
    create('Scoped one');
    create('Scoped two');
    const request = { repositoryId: repository.id, limit: 1 };
    const cursor = store.findSessions(context, request).page.nextCursor!;
    code(() => store.findSessions(context, { repositoryId: randomUUID() }), 'NOT_FOUND');
    code(
      () => store.findSessions({ ...context, user: { ...context.user, id: randomUUID() } }),
      'WORKSPACE_UNAVAILABLE',
    );
    database(store)
      .prepare('UPDATE local_repositories SET generation=generation+1 WHERE id=?')
      .run(repository.id);
    code(() => store.findSessions(context, { ...request, cursor }), 'INVALID_CURSOR');
    const freshCursor = store.findSessions(context, request).page.nextCursor!;
    database(store)
      .prepare('UPDATE local_workspaces SET generation=generation+1 WHERE id=?')
      .run(context.workspace.id);
    code(
      () => store.findSessions(context, { ...request, cursor: freshCursor }),
      'WORKSPACE_UNAVAILABLE',
    );
    const freshContext = store.context();
    code(
      () => store.findSessions(freshContext, { ...request, cursor: freshCursor }),
      'INVALID_CURSOR',
    );
    store.deleteRepository(freshContext, repository.id);
    expect(store.findSessions(freshContext).items).toEqual([]);
    code(() => store.findSessions(freshContext, request), 'NOT_FOUND');
    store.deleteWorkspace(freshContext);
    code(() => store.findSessions(freshContext), 'WORKSPACE_UNAVAILABLE');
  });

  it('keeps cursor signatures and Unicode title filtering stable across restart', () => {
    const path = filePath();
    const { store, context, create } = fixture(path);
    create('Café first');
    create('Café second');
    create('Café third');
    const first = store.findSessions(context, { query: 'CAFE\u0301', limit: 1 });
    store.close();
    const reopened = open(path);
    const rest = reopened.findSessions(context, {
      query: 'café',
      limit: 50,
      cursor: first.page.nextCursor!,
    });
    expect(rest.items).toHaveLength(2);
    expect(rest.items.some((session) => session.id === first.items[0]!.id)).toBe(false);
    expect(rest.page.totalMatching).toBe(3);
  });

  it('returns a truthful empty directory and rejects unsupported direct-store inputs', () => {
    const { store, context } = fixture();
    expect(store.findSessions(context)).toEqual({
      items: [],
      filters: { query: '', repositoryId: null, status: 'all' },
      page: {
        limit: 20,
        returnedItems: 0,
        totalMatching: 0,
        nextCursor: null,
        order: 'newest_created_first',
        consistency: 'live',
      },
    });
    for (const input of [
      { limit: 0 },
      { limit: 51 },
      { limit: '20' },
      { status: 'all' },
      { repositoryId: 'invalid' },
      { query: 'x'.repeat(201) },
      { offset: 1 },
      Object.create({ limit: 1 }),
    ])
      code(
        () => store.findSessions(context, input as SessionDirectoryRequest),
        'INVALID_SESSION_FILTER',
      );
    expect(
      store.findSessions(context, Object.create(null) as SessionDirectoryRequest).items,
    ).toEqual([]);
  });
});
