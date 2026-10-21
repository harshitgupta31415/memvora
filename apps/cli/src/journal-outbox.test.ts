import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateSessionNote } from '@memvora/contracts';
import { prepareSessionNote } from '@memvora/core';
import {
  canonicalJournalOrigin,
  JournalOutbox,
  JournalOutboxError,
  readJournalOutboxPage,
  type JournalPeer,
  type JournalScope,
} from './journal-outbox.js';

const temporaryRoot = realpathSync(tmpdir());
const folders: string[] = [];
const stores: JournalOutbox[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    const target = realpathSync(resolve(folder));
    if (
      dirname(target) !== temporaryRoot ||
      !target.startsWith(join(temporaryRoot, 'memvora-journal-')) ||
      !basename(target).startsWith('memvora-journal-')
    )
      throw new Error('Unsafe journal fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
function directory() {
  const root = mkdtempSync(join(temporaryRoot, 'memvora-journal-'));
  folders.push(root);
  return root;
}
function open(root: string, create = true) {
  const store = new JournalOutbox(root, { create });
  stores.push(store);
  return store;
}
function fixture() {
  const root = directory();
  const store = open(root);
  const scope: JournalScope = {
    apiOrigin: 'http://127.0.0.1:4000',
    repositoryId: randomUUID(),
    sessionId: randomUUID(),
  };
  const peer: JournalPeer = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    workspaceGeneration: 1,
  };
  const input = (text = 'An explicit author claim.'): CreateSessionNote => ({
    id: randomUUID(),
    kind: 'decision',
    body: text,
    eventIds: [],
  });
  const path = join(root, '.memvora', 'journal-outbox.sqlite');
  return { root, store, scope, peer, input, path };
}
function rejects(action: () => unknown, code: string) {
  try {
    action();
    throw new Error('Expected the journal operation to be rejected.');
  } catch (error) {
    expect(error).toBeInstanceOf(JournalOutboxError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('PRIVATE_JOURNAL');
  }
}
function mutate(path: string, update: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(path);
  try {
    update(database);
  } finally {
    database.close();
  }
}

describe('immutable local journal retry storage', () => {
  it('canonicalizes plain loopback origins and rejects secrets, paths and unsafe selectors before creation', () => {
    expect(canonicalJournalOrigin('HTTP://LOCALHOST:80/')).toBe('http://localhost');
    expect(canonicalJournalOrigin('https://[::1]:4000')).toBe('https://[::1]:4000');
    for (const value of [
      'https://remote.example',
      'http://PRIVATE_JOURNAL:secret@localhost',
      'http://localhost/v1',
      'http://localhost?',
      'http://localhost#',
      'http://localhost\n',
      'file:///tmp/a',
    ])
      rejects(() => canonicalJournalOrigin(value), 'INVALID_JOURNAL_INPUT');
    const f = fixture();
    expect(existsSync(join(f.root, '.memvora'))).toBe(false);
    rejects(() => f.store.enqueue(f.scope, f.input(' ')), 'INVALID_JOURNAL_INPUT');
    rejects(
      () => f.store.enqueue({ ...f.scope, sessionId: 'PRIVATE_JOURNAL_BAD_UUID' }, f.input()),
      'INVALID_JOURNAL_INPUT',
    );
    rejects(() => readJournalOutboxPage({ root: f.root, limit: 51 }), 'INVALID_JOURNAL_INPUT');
    rejects(() => readJournalOutboxPage({ root: f.root, after: 0 }), 'INVALID_JOURNAL_INPUT');
    rejects(
      () => readJournalOutboxPage({ root: f.root, after: Number.MAX_SAFE_INTEGER + 1 }),
      'INVALID_JOURNAL_INPUT',
    );
    expect(existsSync(join(f.root, '.memvora'))).toBe(false);
  });

  it('normalizes and redacts before persistence, pins canonical destination identity and replays without database writes', () => {
    const f = fixture();
    const events = [randomUUID(), randomUUID()];
    const input = {
      ...f.input(),
      body: '  pass\u001b[31mword=PRIVATE_JOURNAL_SECRET\r\nAuthor statement.  ',
      eventIds: events,
    };
    const item = f.store.enqueue({ ...f.scope, apiOrigin: `${f.scope.apiOrigin}/` }, input);
    const normalized = prepareSessionNote(input).input;
    expect(f.store.get(item.noteId)).toMatchObject({
      scope: f.scope,
      input: normalized,
      metadata: { state: 'pending', peerPinned: false },
    });
    const envelope = JSON.stringify({ version: 1, scope: f.scope, input: normalized });
    expect(item.payloadBytes).toBe(Buffer.byteLength(envelope));
    expect(item.digest).toBe(createHash('sha256').update(envelope).digest('hex'));
    expect(readFileSync(f.path).toString('utf8')).not.toContain('PRIVATE_JOURNAL_SECRET');
    const before = readFileSync(f.path);
    expect(f.store.enqueue(f.scope, { ...input, eventIds: [...events].reverse() })).toEqual(item);
    expect(readFileSync(f.path)).toEqual(before);
    rejects(
      () => f.store.enqueue(f.scope, { ...input, body: 'Changed author claim.' }),
      'IMMUTABLE_JOURNAL_CONFLICT',
    );
    rejects(
      () => f.store.enqueue({ ...f.scope, sessionId: randomUUID() }, input),
      'IMMUTABLE_JOURNAL_CONFLICT',
    );
    rejects(
      () => f.store.enqueue({ ...f.scope, apiOrigin: 'http://localhost:4000' }, input),
      'IMMUTABLE_JOURNAL_CONFLICT',
    );
    expect(readFileSync(f.path)).toEqual(before);
    expect(readdirSync(join(f.root, '.memvora')).sort()).toEqual([
      '.gitignore',
      'journal-outbox.sqlite',
    ]);
  });

  it('pins the server principal and generation once and requires that pin before durable acknowledgement', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));
    const f = fixture();
    const item = f.store.enqueue(f.scope, f.input());
    rejects(() => f.store.acknowledge(item.noteId, item.digest), 'JOURNAL_ACK_REQUIRES_PRINCIPAL');
    rejects(
      () => f.store.pinPrincipal(item.noteId, 'a'.repeat(64), f.peer),
      'IMMUTABLE_JOURNAL_CONFLICT',
    );
    f.store.pinPrincipal(item.noteId, item.digest, f.peer);
    const before = readFileSync(f.path);
    f.store.pinPrincipal(item.noteId, item.digest, { ...f.peer });
    expect(readFileSync(f.path)).toEqual(before);
    for (const peer of [
      { ...f.peer, userId: randomUUID() },
      { ...f.peer, workspaceId: randomUUID() },
      { ...f.peer, workspaceGeneration: 2 },
    ])
      rejects(
        () => f.store.pinPrincipal(item.noteId, item.digest, peer),
        'JOURNAL_PRINCIPAL_MISMATCH',
      );
    expect(f.store.get(item.noteId)?.peer).toEqual(f.peer);
    expect(f.store.get(item.noteId)?.metadata.state).toBe('pending');
    const confirmed = f.store.acknowledge(item.noteId, item.digest);
    expect(confirmed).toMatchObject({
      state: 'synced',
      peerPinned: true,
      acknowledgedAt: '2026-10-21T12:00:00.000Z',
    });
    vi.advanceTimersByTime(5000);
    expect(f.store.acknowledge(item.noteId, item.digest)).toEqual(confirmed);
    f.store.close();
    const reopened = open(f.root, false);
    expect(reopened.get(item.noteId)).toMatchObject({
      input: expect.any(Object),
      peer: f.peer,
      metadata: confirmed,
    });
    expect(reopened.acknowledge(item.noteId, item.digest)).toEqual(confirmed);
  });

  it('keeps missing-store inspection offline and noncreating and validates metadata without loading bodies', () => {
    const root = directory();
    const before = readdirSync(root);
    expect(readJournalOutboxPage({ root })).toMatchObject({
      source: 'local_journal_outbox',
      exists: false,
      readOnly: true,
      totals: { all: 0, pending: 0, synced: 0 },
      items: [],
      page: { limit: 20, returnedItems: 0, nextAfter: null, consistency: 'live' },
    });
    expect(readdirSync(root)).toEqual(before);
    rejects(() => open(root, false), 'JOURNAL_OUTBOX_MISSING');
    const f = fixture();
    const item = f.store.enqueue(f.scope, f.input('PRIVATE_JOURNAL_BODY_NEVER_LISTED'));
    writeFileSync(join(f.root, '.memvora', 'config.json'), 'PRIVATE_JOURNAL_CONFIG_NOT_JSON');
    writeFileSync(join(f.root, '.memvora', 'local-token'), 'PRIVATE_JOURNAL_TOKEN_NOT_READ');
    const bytes = readFileSync(f.path);
    const entries = readdirSync(join(f.root, '.memvora')).sort();
    const queries: string[] = [];
    const original = DatabaseSync.prototype.prepare;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      queries.push(sql);
      return original.call(this, sql);
    });
    const page = readJournalOutboxPage({ root: f.root });
    spy.mockRestore();
    expect(page.items).toEqual([item]);
    expect(JSON.stringify(page)).not.toContain('PRIVATE_JOURNAL');
    const selections = queries.filter((sql) => /FROM\s+journal_notes/iu.test(sql));
    expect(
      selections.some((sql) => /(?:SELECT|,)\s*payload_json\s*(?:,|FROM)|SELECT\s+\*/iu.test(sql)),
    ).toBe(false);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(readdirSync(join(f.root, '.memvora')).sort()).toEqual(entries);
  });

  it('pages more than 50 notes by live ordinal and reports full-store counts before state/cursor filters', () => {
    const f = fixture();
    const ids: string[] = [];
    for (let index = 0; index < 65; index++) ids.push(f.store.enqueue(f.scope, f.input()).noteId);
    const selected = f.store.get(ids[10]!)!;
    f.store.pinPrincipal(selected.metadata.noteId, selected.digest, f.peer);
    f.store.acknowledge(selected.metadata.noteId, selected.digest);
    expect(readJournalOutboxPage({ root: f.root, state: 'synced' })).toMatchObject({
      totals: { all: 65, pending: 64, synced: 1 },
      items: [{ noteId: ids[10] }],
    });
    const first = readJournalOutboxPage({ root: f.root, state: 'all', limit: 20 });
    expect(first.items.map((item) => item.noteId)).toEqual(ids.slice(0, 20));
    ids.push(f.store.enqueue(f.scope, f.input()).noteId);
    const found = [...first.items];
    const seen = new Set(found.map((item) => item.localRowId));
    let after = first.page.nextAfter;
    for (let pageNumber = 1; after !== null && pageNumber < 4; pageNumber++) {
      expect(Number.isSafeInteger(after) && after > 0).toBe(true);
      const previous = after;
      const page = readJournalOutboxPage({ root: f.root, state: 'all', limit: 20, after });
      for (const item of page.items) {
        expect(item.localRowId).toBeGreaterThan(previous);
        expect(seen.has(item.localRowId)).toBe(false);
        seen.add(item.localRowId);
      }
      found.push(...page.items);
      if (page.page.nextAfter !== null)
        expect(Number.isSafeInteger(page.page.nextAfter) && page.page.nextAfter > previous).toBe(
          true,
        );
      after = page.page.nextAfter;
    }
    expect(after).toBeNull();
    expect(found.map((item) => item.noteId)).toEqual(ids);
    expect(new Set(found.map((item) => item.localRowId)).size).toBe(66);
    const pending = readJournalOutboxPage({
      root: f.root,
      state: 'pending',
      after: first.items[19]!.localRowId,
    });
    expect(pending.totals).toEqual({ all: 66, pending: 65, synced: 1 });
    expect(pending.items.every((item) => item.localRowId > first.items[19]!.localRowId)).toBe(true);
  });

  it('retains acknowledged rows within the 1000-row admission cap and still permits an identical replay', () => {
    const f = fixture();
    const firstInput = f.input();
    const first = f.store.enqueue(f.scope, firstInput);
    f.store.close();
    mutate(f.path, (database) => {
      const statement = database.prepare(
        'INSERT INTO journal_notes(note_id,api_origin,repository_id,session_id,kind,event_count,payload_json,payload_bytes,digest,queued_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      );
      database.exec('BEGIN IMMEDIATE');
      for (let index = 1; index < 1000; index++) {
        const input = prepareSessionNote(f.input()).input;
        const envelope = JSON.stringify({ version: 1, scope: f.scope, input });
        statement.run(
          input.id,
          f.scope.apiOrigin,
          f.scope.repositoryId,
          f.scope.sessionId,
          input.kind,
          input.eventIds.length,
          envelope,
          Buffer.byteLength(envelope),
          createHash('sha256').update(envelope).digest('hex'),
          first.queuedAt,
        );
      }
      database.exec('COMMIT');
    });
    const store = open(f.root, false);
    store.pinPrincipal(first.noteId, first.digest, f.peer);
    store.acknowledge(first.noteId, first.digest);
    const before = readFileSync(f.path);
    expect(store.enqueue(f.scope, firstInput).state).toBe('synced');
    rejects(() => store.enqueue(f.scope, f.input()), 'JOURNAL_OUTBOX_LIMIT');
    expect(readFileSync(f.path)).toEqual(before);
    expect(readJournalOutboxPage({ root: f.root }).totals).toEqual({
      all: 1000,
      pending: 999,
      synced: 1,
    });
  });

  it('refuses linked paths and files and leaves the targets and directory inventory unchanged', () => {
    const f = fixture();
    f.store.enqueue(f.scope, f.input());
    f.store.close();
    const before = readFileSync(f.path);
    const alias = join(f.root, 'journal-hardlink.sqlite');
    linkSync(f.path, alias);
    rejects(() => readJournalOutboxPage({ root: f.root }), 'INVALID_JOURNAL_PATH');
    rejects(() => open(f.root, false), 'INVALID_JOURNAL_PATH');
    unlinkSync(alias);
    const link = join(f.root, 'linked-root');
    symlinkSync(f.root, link, 'junction');
    rejects(() => readJournalOutboxPage({ root: link }), 'INVALID_JOURNAL_PATH');
    rejects(() => open(link), 'INVALID_JOURNAL_PATH');
    expect(readFileSync(f.path)).toEqual(before);
    unlinkSync(link);
  });

  it('does not switch WAL mode or recover a journal during readonly inspection', () => {
    const f = fixture();
    f.store.enqueue(f.scope, f.input());
    f.store.close();
    const before = readFileSync(f.path);
    writeFileSync(`${f.path}-journal`, 'PRIVATE_JOURNAL_ACTIVE_OR_CRASHED_JOURNAL');
    rejects(() => readJournalOutboxPage({ root: f.root }), 'JOURNAL_OUTBOX_UNAVAILABLE');
    expect(readFileSync(f.path)).toEqual(before);
    expect(readFileSync(`${f.path}-journal`, 'utf8')).toBe(
      'PRIVATE_JOURNAL_ACTIVE_OR_CRASHED_JOURNAL',
    );
    unlinkSync(`${f.path}-journal`);
    writeFileSync(`${f.path}-wal`, '');
    rejects(() => readJournalOutboxPage({ root: f.root }), 'JOURNAL_OUTBOX_INVALID');
    unlinkSync(`${f.path}-wal`);
    const header = Buffer.from(before);
    header[18] = 2;
    header[19] = 2;
    writeFileSync(f.path, header);
    rejects(() => readJournalOutboxPage({ root: f.root }), 'JOURNAL_OUTBOX_INVALID');
    expect(readdirSync(join(f.root, '.memvora')).sort()).toEqual([
      '.gitignore',
      'journal-outbox.sqlite',
    ]);
    expect(readFileSync(f.path)).toEqual(header);
  });

  it('rejects unsupported schemas and replaced same-name trigger/index before any mutation', () => {
    for (const sql of [
      'PRAGMA user_version=2',
      'CREATE TABLE unknown_extra(private TEXT)',
      'DROP INDEX journal_notes_state; CREATE INDEX journal_notes_state ON journal_notes(kind)',
      "DROP TRIGGER journal_note_immutable; CREATE TRIGGER journal_note_immutable AFTER UPDATE ON journal_notes BEGIN UPDATE journal_notes SET acknowledged_at='2026-10-21T00:00:00.000Z' WHERE note_id=new.note_id; END",
    ]) {
      const f = fixture();
      const item = f.store.enqueue(f.scope, f.input());
      mutate(f.path, (database) => database.exec(sql));
      const before = readFileSync(f.path);
      rejects(
        () => f.store.pinPrincipal(item.noteId, item.digest, f.peer),
        'JOURNAL_OUTBOX_INVALID',
      );
      rejects(() => readJournalOutboxPage({ root: f.root }), 'JOURNAL_OUTBOX_INVALID');
      expect(readFileSync(f.path)).toEqual(before);
    }
    const root = directory();
    mkdirSync(join(root, '.memvora'));
    const path = join(root, '.memvora', 'journal-outbox.sqlite');
    writeFileSync(path, 'PRIVATE_JOURNAL_NOT_A_DATABASE');
    const before = readFileSync(path);
    rejects(() => readJournalOutboxPage({ root }), 'JOURNAL_OUTBOX_INVALID');
    expect(readFileSync(path)).toEqual(before);
  });

  it('fails safely on a corrupted selected payload while leaving another pending note retrievable', () => {
    const f = fixture();
    const damaged = f.store.enqueue(f.scope, f.input());
    const valid = f.store.enqueue(f.scope, f.input());
    mutate(f.path, (database) => {
      const trigger = String(
        database
          .prepare("SELECT sql FROM sqlite_schema WHERE name='journal_note_immutable'")
          .get()!['sql'],
      );
      database.exec('DROP TRIGGER journal_note_immutable');
      const corrupt = '{"PRIVATE_JOURNAL_INVALID_JSON":';
      database
        .prepare('UPDATE journal_notes SET payload_json=?,payload_bytes=? WHERE note_id=?')
        .run(corrupt, Buffer.byteLength(corrupt), damaged.noteId);
      database.exec(trigger);
    });
    rejects(() => f.store.get(damaged.noteId), 'JOURNAL_OUTBOX_INVALID');
    expect(f.store.get(valid.noteId)?.metadata.state).toBe('pending');
    const page = readJournalOutboxPage({ root: f.root });
    expect(page.items.map((item) => item.noteId)).toEqual([damaged.noteId, valid.noteId]);
    expect(JSON.stringify(page)).not.toContain('PRIVATE_JOURNAL');
    rejects(() => f.store.acknowledge(damaged.noteId, damaged.digest), 'JOURNAL_OUTBOX_INVALID');
  });
});
