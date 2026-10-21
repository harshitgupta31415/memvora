import { randomUUID } from 'node:crypto';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalOutbox } from './local.js';
import { readExistingOutboxPage } from './outbox-inspection.js';

const temporaryRoot = realpathSync(tmpdir());
const folders: string[] = [];
const outboxes: LocalOutbox[] = [];
afterEach(() => {
  for (const outbox of outboxes.splice(0)) outbox.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) {
    const target = realpathSync(folder);
    if (
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-inspection-') ||
      !target.startsWith(join(temporaryRoot, 'memvora-inspection-'))
    )
      throw new Error('Unsafe inspection fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
function root() {
  const value = mkdtempSync(join(temporaryRoot, 'memvora-inspection-'));
  folders.push(value);
  return value;
}
function fixture() {
  const directory = root();
  const path = join(directory, '.memvora', 'outbox.sqlite');
  const outbox = new LocalOutbox(path);
  outboxes.push(outbox);
  const sessionId = randomUUID();
  const repositoryId = randomUUID();
  const capture = (session = sessionId, finalize = true, executable = 'node') => {
    const eventId = randomUUID();
    const initial = {
      eventId,
      sessionId: session,
      repositoryId,
      startedAt: '2026-10-21T10:00:00.000Z',
      command: { executable, args: ['DO_NOT_PRINT_ARGUMENT_SECRET'] },
      cwd: 'DO_NOT_PRINT_CWD',
      diffs: [{ text: 'DO_NOT_PRINT_DIFF' }],
    };
    const sequence = outbox.begin(eventId, session, initial);
    if (finalize)
      outbox.finalize(eventId, { ...initial, sequence, output: [{ text: 'DO_NOT_PRINT_OUTPUT' }] });
    return { eventId, sequence, initial };
  };
  return { root: directory, path, outbox, sessionId, repositoryId, capture };
}
function update(path: string, action: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(path);
  try {
    action(database);
  } finally {
    database.close();
  }
}

describe('offline local outbox metadata inspection', () => {
  it('reads metadata without API, token, config, PID probes, recovery or source changes', () => {
    const f = fixture();
    const synced = f.capture();
    f.outbox.acknowledge([synced.eventId], [synced.eventId]);
    const pending = f.capture();
    const incomplete = f.capture(f.sessionId, false);
    writeFileSync(join(f.root, '.memvora', 'config.json'), 'not valid config; must not be read');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'INVALID_DO_NOT_READ_CREDENTIAL');
    const fetcher = vi.fn(() => {
      throw new Error('Offline inspection must not call API.');
    });
    vi.stubGlobal('fetch', fetcher);
    const pidProbe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Inspection must not probe owners.');
    });
    const before = readFileSync(f.path);
    const walBefore = readFileSync(`${f.path}-wal`);
    try {
      const page = readExistingOutboxPage({ root: f.root });
      expect(page).toMatchObject({
        exists: true,
        readOnly: true,
        filter: { state: 'unsynced', sessionId: null },
        totals: { all: 3, unsynced: 2, pending: 1, incomplete: 1, synced: 1 },
      });
      expect(page.items.map((item) => item.eventId)).toEqual([pending.eventId, incomplete.eventId]);
      expect(page.items.every((item) => item.metadataValid)).toBe(true);
      expect(page.items[0]).toMatchObject({
        repositoryId: f.repositoryId,
        executable: 'node',
        argumentsCount: 1,
        sequence: 2,
        state: 'pending',
      });
      expect(page.items[1]?.payloadBytes).toBeNull();
      for (const secret of [
        'DO_NOT_PRINT_ARGUMENT_SECRET',
        'DO_NOT_PRINT_CWD',
        'DO_NOT_PRINT_DIFF',
        'DO_NOT_PRINT_OUTPUT',
        'INVALID_DO_NOT_READ_CREDENTIAL',
      ])
        expect(JSON.stringify(page)).not.toContain(secret);
      expect(fetcher).not.toHaveBeenCalled();
      expect(pidProbe).not.toHaveBeenCalled();
      expect(readFileSync(f.path)).toEqual(before);
      expect(readFileSync(`${f.path}-wal`)).toEqual(walBefore);
      expect(f.outbox.counts()).toEqual({ pending: 1, incomplete: 1 });
    } finally {
      pidProbe.mockRestore();
    }
  });

  it('returns explicit missing state without creating directories and validates selectors before touching a file', () => {
    const directory = root();
    expect(readExistingOutboxPage({ root: directory })).toMatchObject({
      exists: false,
      items: [],
      page: { nextAfter: null },
      totals: { all: 0 },
    });
    expect(readdirSync(directory)).toEqual([]);
    for (const query of [
      { limit: 0 },
      { limit: 51 },
      { after: 0 },
      { after: 1.5 },
      { sessionId: 'bad' },
      { state: 'bad' },
      { unexpected: true },
    ])
      expect(() => readExistingOutboxPage({ root: directory, ...query } as never)).toThrow(
        'bounded page selectors',
      );
    expect(readdirSync(directory)).toEqual([]);
    expect(() => readExistingOutboxPage({ root: 'relative' })).toThrow('bounded page selectors');
  });

  it('pages oldest row IDs without duplicate/drop under tied timestamps and reports scoped live counts', () => {
    const f = fixture();
    const other = randomUUID();
    const records = Array.from({ length: 125 }, (_, index) =>
      f.capture(index % 5 === 0 ? other : f.sessionId),
    );
    update(f.path, (database) =>
      database.exec("UPDATE executions SET created_at='2026-10-21T10:00:00.000Z'"),
    );
    const expected = records
      .filter((_record, index) => index % 5 !== 0)
      .map((record) => record.eventId);
    let page = readExistingOutboxPage({ root: f.root, sessionId: f.sessionId, limit: 17 });
    const found = page.items.map((item) => item.eventId);
    expect(page.totals).toMatchObject({ all: 100, pending: 100, unsynced: 100 });
    while (page.page.nextAfter !== null) {
      page = readExistingOutboxPage({
        root: f.root,
        sessionId: f.sessionId,
        limit: 17,
        after: page.page.nextAfter,
      });
      found.push(...page.items.map((item) => item.eventId));
    }
    expect(found).toEqual(expected);
    expect(new Set(found).size).toBe(expected.length);
    const first = readExistingOutboxPage({ root: f.root, state: 'pending', limit: 10 });
    f.outbox.acknowledge([first.items[0]!.eventId!], [first.items[0]!.eventId!]);
    const appended = f.capture();
    const next = readExistingOutboxPage({
      root: f.root,
      state: 'pending',
      after: first.page.nextAfter!,
      limit: 50,
    });
    expect(next.items[0]?.localRowId).toBeGreaterThan(first.items.at(-1)!.localRowId);
    expect(next.totals).toMatchObject({ all: 126, pending: 125, synced: 1 });
    expect(
      readExistingOutboxPage({ root: f.root, state: 'all', after: 125 }).items[0]?.eventId,
    ).toBe(appended.eventId);
  });

  it('keeps malformed, oversized and invalid-ID metadata rows visible without printing untrusted raw values', () => {
    const f = fixture();
    const malformed = f.capture();
    const oversized = f.capture();
    const invalid = f.capture();
    update(f.path, (database) => {
      database
        .prepare('UPDATE executions SET initial_payload=? WHERE id=?')
        .run('{PRIVATE_BAD_JSON', malformed.eventId);
      database
        .prepare('UPDATE executions SET initial_payload=? WHERE id=?')
        .run(
          JSON.stringify({ ...oversized.initial, private: 'PRIVATE_OVERSIZE'.repeat(25_000) }),
          oversized.eventId,
        );
      database
        .prepare('UPDATE executions SET id=?,session_id=?,sequence=?,created_at=? WHERE id=?')
        .run('PRIVATE_ID\u001b[31m', 'PRIVATE_SESSION', 0, 'PRIVATE_TIME', invalid.eventId);
    });
    const page = readExistingOutboxPage({ root: f.root, state: 'all' });
    expect(page.items).toHaveLength(3);
    expect(page.items.every((item) => !item.metadataValid)).toBe(true);
    expect(page.items[2]).toMatchObject({
      eventId: null,
      sessionId: null,
      sequence: null,
      createdAt: null,
    });
    for (const marker of [
      'PRIVATE_BAD_JSON',
      'PRIVATE_OVERSIZE',
      'PRIVATE_ID',
      'PRIVATE_SESSION',
      'PRIVATE_TIME',
    ])
      expect(JSON.stringify(page)).not.toContain(marker);
    expect(f.outbox.counts().pending).toBe(3);
  });

  it('strips terminal controls, bidi and known credentials and clips executable text on Unicode boundaries', () => {
    const f = fixture();
    f.capture(
      f.sessionId,
      true,
      '\u001b[31mnode\u001b[0m \u202epass\u0000word="private secret value" ' + '😀'.repeat(120),
    );
    const item = readExistingOutboxPage({ root: f.root }).items[0]!;
    expect(item.metadataValid).toBe(true);
    expect(item.executable).toContain('[REDACTED]');
    expect(item.executable).not.toContain('private secret value');
    expect(item.executable).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/u);
    expect(item.executable!.length).toBeLessThanOrEqual(200);
    expect(item.executable).not.toMatch(/[\ud800-\udbff]$/u);
  });

  it('supports ownerless legacy executions without adding owner_pid or any other schema', () => {
    const directory = root();
    mkdirSync(join(directory, '.memvora'));
    const path = join(directory, '.memvora', 'outbox.sqlite');
    const eventId = randomUUID();
    const sessionId = randomUUID();
    update(path, (database) => {
      database.exec(
        "CREATE TABLE executions (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,initial_payload TEXT NOT NULL,payload TEXT,synced INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT '2026-10-21T10:00:00.000Z')",
      );
      database
        .prepare('INSERT INTO executions(id,session_id,sequence,initial_payload) VALUES(?,?,?,?)')
        .run(
          eventId,
          sessionId,
          1,
          JSON.stringify({
            eventId,
            sessionId,
            repositoryId: randomUUID(),
            startedAt: '2026-10-21T10:00:00.000Z',
            command: { executable: 'node', args: [] },
          }),
        );
    });
    const before = readFileSync(path);
    const entries = readdirSync(join(directory, '.memvora'));
    expect(readExistingOutboxPage({ root: directory }).items[0]).toMatchObject({
      eventId,
      state: 'incomplete',
      metadataValid: true,
    });
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(directory, '.memvora'))).toEqual(entries);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        database
          .prepare('PRAGMA table_info(executions)')
          .all()
          .some((column) => column['name'] === 'owner_pid'),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it('rejects unrelated databases, linked directories and hardlinked outbox files without rewriting them', () => {
    const directory = root();
    mkdirSync(join(directory, '.memvora'));
    const path = join(directory, '.memvora', 'outbox.sqlite');
    writeFileSync(path, 'PRIVATE_UNRELATED_DATABASE');
    const before = readFileSync(path);
    expect(() => readExistingOutboxPage({ root: directory })).toThrow('unsupported schema');
    expect(readFileSync(path)).toEqual(before);
    const f = fixture();
    const linked = root();
    symlinkSync(join(f.root, '.memvora'), join(linked, '.memvora'), 'junction');
    expect(() => readExistingOutboxPage({ root: linked })).toThrow('safely inspected');
    const hardlinked = root();
    mkdirSync(join(hardlinked, '.memvora'));
    linkSync(f.path, join(hardlinked, '.memvora', 'outbox.sqlite'));
    expect(() => readExistingOutboxPage({ root: hardlinked })).toThrow('safely inspected');
    expect(existsSync(join(hardlinked, '.memvora', 'config.json'))).toBe(false);
  });

  it('selects pending and incomplete rows before parsing poisoned siblings, keeps cutoff membership and enforces exact ACKs', () => {
    const f = fixture();
    const bad = f.capture();
    const otherSession = randomUUID();
    const healthy = f.capture(otherSession);
    const unfinished = f.capture(otherSession, false);
    update(f.path, (database) =>
      database
        .prepare('UPDATE executions SET payload=?,initial_payload=? WHERE id=?')
        .run('{PRIVATE_POISON', '{PRIVATE_INITIAL', bad.eventId),
    );
    expect(() => f.outbox.pending()).toThrow();
    try {
      f.outbox.pending();
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_POISON');
    }
    expect(f.outbox.pending({ sessionId: otherSession }).map((row) => row.eventId)).toEqual([
      healthy.eventId,
    ]);
    expect(f.outbox.incomplete({ sessionId: otherSession }).map((row) => row.eventId)).toEqual([
      unfinished.eventId,
    ]);
    expect(f.outbox.counts({ sessionId: otherSession })).toEqual({ pending: 1, incomplete: 1 });
    const cutoff = f.outbox.lastRowId();
    const later = f.capture(otherSession);
    expect(f.outbox.pending({ sessionId: otherSession }, cutoff).map((row) => row.eventId)).toEqual(
      [healthy.eventId],
    );
    expect(f.outbox.pending({ eventId: later.eventId }, 0)).toEqual([]);
    expect(() =>
      f.outbox.acknowledge([healthy.eventId, healthy.eventId], [healthy.eventId]),
    ).toThrow('Duplicate');
    expect(() => f.outbox.acknowledge([healthy.eventId, bad.eventId], [healthy.eventId])).toThrow(
      'outside',
    );
    expect(f.outbox.acknowledge([healthy.eventId], [healthy.eventId])).toBe(1);
    expect(f.outbox.acknowledge([healthy.eventId], [healthy.eventId])).toBe(0);
    expect(f.outbox.counts({ eventId: bad.eventId })).toEqual({ pending: 1, incomplete: 0 });
    for (const filter of [
      { sessionId: 'bad' },
      { eventId: bad.eventId, sessionId: otherSession },
      { unexpected: true },
    ])
      expect(() => f.outbox.pending(filter as never)).toThrow('one valid');
    expect(() => f.outbox.pending(undefined, -1)).toThrow('cutoff');
    update(f.path, (database) =>
      database
        .prepare('UPDATE executions SET payload=? WHERE id=?')
        .run(
          JSON.stringify({ ...later.initial, sessionId: f.sessionId, sequence: later.sequence }),
          later.eventId,
        ),
    );
    expect(() => f.outbox.pending({ eventId: later.eventId })).toThrow(
      'inconsistent stored identity',
    );
  });

  it('retains oversized selected envelopes and unfinished metadata and hides malformed unfiltered JSON diagnostics', () => {
    const f = fixture();
    const oversized = f.capture();
    const unfinished = f.capture(f.sessionId, false);
    const healthySession = randomUUID();
    const healthy = f.capture(healthySession);
    update(f.path, (database) => {
      database.prepare('UPDATE executions SET payload=? WHERE id=?').run(
        JSON.stringify({
          ...oversized.initial,
          sequence: oversized.sequence,
          private: 'x'.repeat(2_000_000),
        }),
        oversized.eventId,
      );
      database
        .prepare('UPDATE executions SET initial_payload=? WHERE id=?')
        .run(
          JSON.stringify({ ...unfinished.initial, private: 'y'.repeat(300_000) }),
          unfinished.eventId,
        );
    });
    expect(() => f.outbox.pending({ eventId: oversized.eventId })).toThrow(
      'exceeds the upload limit',
    );
    expect(f.outbox.pending({ sessionId: healthySession }).map((row) => row.eventId)).toEqual([
      healthy.eventId,
    ]);
    expect(() => f.outbox.incomplete({ eventId: unfinished.eventId })).toThrow('stored identity');
    expect(f.outbox.counts()).toEqual({ pending: 2, incomplete: 1 });
    update(f.path, (database) =>
      database
        .prepare('UPDATE executions SET initial_payload=? WHERE id=?')
        .run('{PRIVATE_UNFINISHED_JSON', unfinished.eventId),
    );
    expect(() => f.outbox.incomplete()).toThrow('invalid JSON metadata');
    try {
      f.outbox.incomplete();
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_UNFINISHED_JSON');
    }
    expect(f.outbox.counts()).toEqual({ pending: 2, incomplete: 1 });
  });
});
