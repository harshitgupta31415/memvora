import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { Check } from 'typebox/value';
import { IdSchema, type CreateSessionNote } from '@memvora/contracts';
import { prepareSessionNote as prepareCanonicalNote } from '@memvora/core';

export interface JournalScope {
  apiOrigin: string;
  repositoryId: string;
  sessionId: string;
}
export interface JournalPeer {
  workspaceId: string;
  userId: string;
  workspaceGeneration: number;
}
export interface JournalOutboxItem {
  localRowId: number;
  noteId: string;
  repositoryId: string;
  sessionId: string;
  apiOrigin: string;
  kind: CreateSessionNote['kind'];
  eventCount: number;
  payloadBytes: number;
  digest: string;
  queuedAt: string;
  acknowledgedAt: string | null;
  state: 'pending' | 'synced';
  peerPinned: boolean;
}
export interface QueuedJournalNote {
  metadata: JournalOutboxItem;
  scope: JournalScope;
  input: CreateSessionNote;
  digest: string;
  peer: JournalPeer | null;
}
export interface JournalOutboxPageQuery {
  root: string;
  state?: 'pending' | 'synced' | 'all';
  limit?: number;
  after?: number;
}
export interface JournalOutboxPage {
  source: 'local_journal_outbox';
  exists: boolean;
  readOnly: true;
  totals: { all: number; pending: number; synced: number };
  items: JournalOutboxItem[];
  page: { limit: number; returnedItems: number; nextAfter: number | null; consistency: 'live' };
  notice: string;
}
export type JournalOutboxErrorCode =
  | 'INVALID_JOURNAL_INPUT'
  | 'INVALID_JOURNAL_PATH'
  | 'JOURNAL_OUTBOX_MISSING'
  | 'JOURNAL_OUTBOX_INVALID'
  | 'JOURNAL_OUTBOX_UNAVAILABLE'
  | 'JOURNAL_OUTBOX_LIMIT'
  | 'IMMUTABLE_JOURNAL_CONFLICT'
  | 'JOURNAL_PRINCIPAL_MISMATCH'
  | 'JOURNAL_ACK_REQUIRES_PRINCIPAL'
  | 'JOURNAL_NOTE_NOT_FOUND';
export class JournalOutboxError extends Error {
  constructor(
    public readonly code: JournalOutboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JournalOutboxError';
  }
}
const invalid = () =>
  new JournalOutboxError(
    'JOURNAL_OUTBOX_INVALID',
    'The existing journal outbox is invalid. Its notes were retained.',
  );
const invalidInput = () =>
  new JournalOutboxError(
    'INVALID_JOURNAL_INPUT',
    'Use valid journal scope, note identity and bounded canonical input.',
  );
const invalidPath = () =>
  new JournalOutboxError(
    'INVALID_JOURNAL_PATH',
    'Use a regular absolute local directory without linked path components.',
  );
const unavailable = () =>
  new JournalOutboxError(
    'JOURNAL_OUTBOX_UNAVAILABLE',
    'The local journal outbox is unavailable. No remote acknowledgement was recorded.',
  );
const missing = () =>
  new JournalOutboxError('JOURNAL_OUTBOX_MISSING', 'No existing local journal outbox was found.');
const MAX_ROWS = 1000;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value: unknown): value is string => Check(IdSchema, value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
type Row = Record<string, SQLOutputValue>;
function safe<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof JournalOutboxError) throw error;
    throw unavailable();
  }
}

/** Canonical destination identity; credentials, path/query/fragment and remote hosts are invalid. */
export function canonicalJournalOrigin(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f-\u009f?#]/u.test(value)
  )
    throw invalidInput();
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw invalidInput();
    return url.origin;
  } catch {
    throw invalidInput();
  }
}
function scope(value: JournalScope): JournalScope {
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !== 'apiOrigin,repositoryId,sessionId' ||
    !id(value.repositoryId) ||
    !id(value.sessionId)
  )
    throw invalidInput();
  return {
    apiOrigin: canonicalJournalOrigin(value.apiOrigin),
    repositoryId: value.repositoryId,
    sessionId: value.sessionId,
  };
}
function principal(value: JournalPeer): JournalPeer {
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !== 'userId,workspaceGeneration,workspaceId' ||
    !id(value.workspaceId) ||
    !id(value.userId) ||
    !positive(value.workspaceGeneration)
  )
    throw invalidInput();
  return {
    workspaceId: value.workspaceId,
    userId: value.userId,
    workspaceGeneration: value.workspaceGeneration,
  };
}
function prepare(target: JournalScope, input: CreateSessionNote) {
  const selected = scope(target);
  let normalized: CreateSessionNote;
  try {
    normalized = prepareCanonicalNote(input).input;
  } catch {
    throw invalidInput();
  }
  const json = JSON.stringify({ version: 1, scope: selected, input: normalized });
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES)
    throw new JournalOutboxError(
      'JOURNAL_OUTBOX_LIMIT',
      'The canonical journal request exceeds 32 KiB.',
    );
  return {
    scope: selected,
    input: normalized,
    json,
    bytes,
    digest: createHash('sha256').update(json).digest('hex'),
  };
}

function rootPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    !isAbsolute(value) ||
    /^[\\/]{2}/u.test(value) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    throw invalidPath();
  return resolve(value);
}
/** Returns false only when a component is missing; links and non-directories always fail. */
function regularDirectory(path: string): boolean {
  let current = parse(path).root;
  for (const segment of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalidPath();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    }
  }
  return true;
}
function storePath(root: string, readOnly: boolean): { path: string; exists: boolean } {
  const directory = join(root, '.memvora');
  if (!regularDirectory(directory))
    return { path: join(directory, 'journal-outbox.sqlite'), exists: false };
  const path = join(realpathSync(directory), 'journal-outbox.sqlite');
  let exists = false;
  let bytes = 0;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const entry = lstatSync(`${path}${suffix}`);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw invalidPath();
      bytes += entry.size;
      if (suffix === '') exists = true;
      if (readOnly && suffix === '-journal' && entry.size > 0) throw unavailable();
      // This store is always rollback-journal mode. A WAL sidecar is incompatible state.
      if (suffix === '-wal' || suffix === '-shm') throw invalid();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        continue;
      throw error;
    }
  }
  if (bytes > MAX_STORE_BYTES)
    throw new JournalOutboxError(
      'JOURNAL_OUTBOX_LIMIT',
      'The existing journal outbox exceeds its 64 MiB storage limit.',
    );
  if (!exists && bytes > 0) throw invalid();
  if (exists) {
    // Refuse WAL before SQLite opens a readonly connection, which could create sidecars.
    const descriptor = openSync(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    try {
      if (!fstatSync(descriptor).isFile() || fstatSync(descriptor).nlink !== 1) throw invalidPath();
      const header = Buffer.alloc(100);
      if (
        readSync(descriptor, header, 0, header.length, 0) !== 100 ||
        header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
        header[18] !== 1 ||
        header[19] !== 1
      )
        throw invalid();
    } finally {
      closeSync(descriptor);
    }
  }
  return { path, exists };
}
const stateIndexSql =
  'CREATE INDEX journal_notes_state ON journal_notes(acknowledged_at,local_row_id)';
const immutableTriggerSql = `CREATE TRIGGER journal_note_immutable BEFORE UPDATE OF note_id,api_origin,repository_id,session_id,kind,event_count,payload_json,payload_bytes,digest,queued_at ON journal_notes BEGIN
  SELECT RAISE(ABORT,'JOURNAL_NOTE_IMMUTABLE');
END`;
const normalizedSql = (value: string): string =>
  value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
const schemaSql = `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
BEGIN IMMEDIATE;
CREATE TABLE journal_notes (
  local_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL UNIQUE,
  api_origin TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('note','decision','resolution')),
  event_count INTEGER NOT NULL CHECK(event_count BETWEEN 0 AND 10),
  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 32768),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 32768),
  digest TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  acknowledged_at TEXT,
  peer_workspace_id TEXT,
  peer_user_id TEXT,
  peer_workspace_generation INTEGER,
  CHECK((peer_workspace_id IS NULL AND peer_user_id IS NULL AND peer_workspace_generation IS NULL) OR
    (peer_workspace_id IS NOT NULL AND peer_user_id IS NOT NULL AND peer_workspace_generation IS NOT NULL AND peer_workspace_generation>=1)),
  CHECK(acknowledged_at IS NULL OR peer_workspace_id IS NOT NULL)
) STRICT;
${stateIndexSql};
${immutableTriggerSql};
PRAGMA user_version=1;
COMMIT;
`;
const columns = [
  'local_row_id',
  'note_id',
  'api_origin',
  'repository_id',
  'session_id',
  'kind',
  'event_count',
  'payload_json',
  'payload_bytes',
  'digest',
  'queued_at',
  'acknowledged_at',
  'peer_workspace_id',
  'peer_user_id',
  'peer_workspace_generation',
];
function schema(database: DatabaseSync): void {
  if (
    database.prepare('PRAGMA user_version').get()?.['user_version'] !== 1 ||
    database.prepare('PRAGMA journal_mode').get()?.['journal_mode'] !== 'delete'
  )
    throw invalid();
  const objects = database
    .prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_autoindex_*'")
    .all();
  const expected = new Map([
    ['journal_notes', 'table'],
    ['sqlite_sequence', 'table'],
    ['journal_notes_state', 'index'],
    ['journal_note_immutable', 'trigger'],
  ]);
  if (
    objects.length !== expected.size ||
    objects.some((row) => expected.get(String(row['name'])) !== row['type'])
  )
    throw invalid();
  for (const [name, sql] of [
    ['journal_notes_state', stateIndexSql],
    ['journal_note_immutable', immutableTriggerSql],
  ] as const) {
    const stored = objects.find((row) => row['name'] === name)?.['sql'];
    if (typeof stored !== 'string' || normalizedSql(stored) !== normalizedSql(sql)) throw invalid();
  }
  const definition = objects.find((row) => row['name'] === 'journal_notes')?.['sql'];
  if (
    typeof definition !== 'string' ||
    !/\bSTRICT\s*$/iu.test(definition) ||
    /\b(?:VIRTUAL|WITHOUT\s+ROWID)\b/iu.test(definition)
  )
    throw invalid();
  const actual = database.prepare('PRAGMA table_info(journal_notes)').all();
  const integers = new Set([
    'local_row_id',
    'event_count',
    'payload_bytes',
    'peer_workspace_generation',
  ]);
  const nullableColumns = new Set([
    'acknowledged_at',
    'peer_workspace_id',
    'peer_user_id',
    'peer_workspace_generation',
  ]);
  if (
    actual.length !== columns.length ||
    actual.some(
      (row, index) =>
        row['name'] !== columns[index] ||
        row['type'] !== (integers.has(String(row['name'])) ? 'INTEGER' : 'TEXT') ||
        row['pk'] !== (index === 0 ? 1 : 0) ||
        (index !== 0 && row['notnull'] !== (nullableColumns.has(String(row['name'])) ? 0 : 1)),
    )
  )
    throw invalid();
  const total = database.prepare('SELECT count(*) AS count FROM journal_notes').get()?.['count'];
  if (!nonnegative(total) || total > MAX_ROWS) throw invalid();
}
const metadataSql = `local_row_id,note_id,api_origin,repository_id,session_id,kind,event_count,
  payload_bytes,digest,queued_at,acknowledged_at,peer_workspace_id,peer_user_id,peer_workspace_generation,
  length(CAST(payload_json AS BLOB)) AS actual_payload_bytes`;
function metadata(row: Row): JournalOutboxItem {
  const pinned =
    row['peer_workspace_id'] !== null ||
    row['peer_user_id'] !== null ||
    row['peer_workspace_generation'] !== null;
  if (
    !positive(row['local_row_id']) ||
    !id(row['note_id']) ||
    !id(row['repository_id']) ||
    !id(row['session_id']) ||
    typeof row['api_origin'] !== 'string' ||
    canonicalJournalOrigin(row['api_origin']) !== row['api_origin'] ||
    !['note', 'decision', 'resolution'].includes(String(row['kind'])) ||
    !nonnegative(row['event_count']) ||
    row['event_count'] > 10 ||
    !positive(row['payload_bytes']) ||
    row['payload_bytes'] > MAX_PAYLOAD_BYTES ||
    row['payload_bytes'] !== row['actual_payload_bytes'] ||
    !hash(row['digest']) ||
    !timestamp(row['queued_at']) ||
    (row['acknowledged_at'] !== null && !timestamp(row['acknowledged_at'])) ||
    (pinned &&
      (!id(row['peer_workspace_id']) ||
        !id(row['peer_user_id']) ||
        !positive(row['peer_workspace_generation']))) ||
    (row['acknowledged_at'] !== null && !pinned)
  )
    throw invalid();
  return {
    localRowId: row['local_row_id'],
    noteId: row['note_id'],
    repositoryId: row['repository_id'],
    sessionId: row['session_id'],
    apiOrigin: row['api_origin'],
    kind: row['kind'] as CreateSessionNote['kind'],
    eventCount: row['event_count'],
    payloadBytes: row['payload_bytes'],
    digest: row['digest'],
    queuedAt: row['queued_at'],
    acknowledgedAt: row['acknowledged_at'] as string | null,
    state: row['acknowledged_at'] === null ? 'pending' : 'synced',
    peerPinned: pinned,
  };
}
function queued(row: Row): QueuedJournalNote {
  const item = metadata(row);
  if (typeof row['payload_json'] !== 'string') throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(row['payload_json']);
  } catch {
    throw invalid();
  }
  if (
    !plain(value) ||
    Object.keys(value).sort().join(',') !== 'input,scope,version' ||
    value.version !== 1
  )
    throw invalid();
  let canonical: ReturnType<typeof prepare>;
  try {
    canonical = prepare(value.scope as JournalScope, value.input as CreateSessionNote);
  } catch {
    throw invalid();
  }
  if (
    canonical.json !== row['payload_json'] ||
    canonical.digest !== item.digest ||
    canonical.bytes !== item.payloadBytes ||
    canonical.input.id !== item.noteId ||
    canonical.input.kind !== item.kind ||
    canonical.input.eventIds.length !== item.eventCount ||
    canonical.scope.apiOrigin !== item.apiOrigin ||
    canonical.scope.repositoryId !== item.repositoryId ||
    canonical.scope.sessionId !== item.sessionId
  )
    throw invalid();
  return {
    metadata: item,
    scope: canonical.scope,
    input: canonical.input,
    digest: item.digest,
    peer: item.peerPinned
      ? {
          workspaceId: row['peer_workspace_id'] as string,
          userId: row['peer_user_id'] as string,
          workspaceGeneration: row['peer_workspace_generation'] as number,
        }
      : null,
  };
}
function transaction<T>(
  database: DatabaseSync,
  action: () => T,
  mode: 'read' | 'write' = 'write',
): T {
  database.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    schema(database);
    const value = action();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Only enqueue creates a store. Existing-store mutations never run schema migrations. */
export class JournalOutbox {
  private readonly root: string;
  private readonly create: boolean;
  private database: DatabaseSync | null = null;
  private identity: { dev: number; ino: number; birthtimeMs: number } | null = null;
  private closed = false;
  constructor(root: string, options: { create: boolean }) {
    if (
      !plain(options) ||
      Object.keys(options).join(',') !== 'create' ||
      typeof options.create !== 'boolean'
    )
      throw invalidInput();
    this.root = rootPath(root);
    this.create = options.create;
    safe(() => {
      if (!regularDirectory(this.root)) throw invalidPath();
      const selected = storePath(this.root, false);
      if (selected.exists) this.database = this.open(selected.path);
      else if (!this.create) throw missing();
    });
  }
  private open(path: string): DatabaseSync {
    const before = lstatSync(path);
    const database = new DatabaseSync(path, { timeout: 5000, allowExtension: false });
    try {
      database.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;');
      schema(database);
      const after = lstatSync(path);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.birthtimeMs !== after.birthtimeMs
      )
        throw invalidPath();
      this.identity = { dev: after.dev, ino: after.ino, birthtimeMs: after.birthtimeMs };
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  private db(create = false): DatabaseSync {
    if (this.closed) throw unavailable();
    if (this.database) {
      const selected = storePath(this.root, false);
      if (!selected.exists || !this.identity) throw invalid();
      const entry = lstatSync(selected.path);
      if (
        entry.dev !== this.identity.dev ||
        entry.ino !== this.identity.ino ||
        entry.birthtimeMs !== this.identity.birthtimeMs
      )
        throw invalidPath();
      return this.database;
    }
    const selected = storePath(this.root, false);
    if (selected.exists) {
      this.database = this.open(selected.path);
      return this.database;
    }
    if (!create || !this.create) throw missing();
    const directory = join(this.root, '.memvora');
    if (!regularDirectory(directory)) mkdirSync(directory, { mode: 0o700 });
    try {
      writeFileSync(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        throw error;
      const entry = lstatSync(join(directory, '.gitignore'));
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw invalidPath();
    }
    // Exclusive reservation prevents replacing a pre-existing file or link.
    let reserved = false;
    try {
      const descriptor = openSync(selected.path, 'wx', 0o600);
      closeSync(descriptor);
      reserved = true;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        throw error;
    }
    if (!reserved) {
      const current = storePath(this.root, false);
      if (!current.exists) throw invalid();
      this.database = this.open(current.path);
      return this.database;
    }
    const database = new DatabaseSync(selected.path, { timeout: 5000, allowExtension: false });
    try {
      database.exec(schemaSql);
      database.exec('PRAGMA trusted_schema=OFF;');
      schema(database);
      const entry = lstatSync(selected.path);
      this.identity = { dev: entry.dev, ino: entry.ino, birthtimeMs: entry.birthtimeMs };
      this.database = database;
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  private getFrom(database: DatabaseSync, noteId: string): QueuedJournalNote | null {
    const row = database
      .prepare(
        `SELECT ${metadataSql},CASE WHEN length(CAST(payload_json AS BLOB))<=32768 THEN payload_json ELSE NULL END AS payload_json FROM journal_notes WHERE note_id=?`,
      )
      .get(noteId);
    return row ? queued(row) : null;
  }
  enqueue(target: JournalScope, input: CreateSessionNote): JournalOutboxItem {
    const canonical = prepare(target, input); // Normalize/redact before any store creation.
    return safe(() => {
      const database = this.db(true);
      return transaction(database, () => {
        const existing = this.getFrom(database, canonical.input.id);
        if (existing) {
          if (existing.digest !== canonical.digest)
            throw new JournalOutboxError(
              'IMMUTABLE_JOURNAL_CONFLICT',
              'The note UUID is already bound to another immutable journal request.',
            );
          return existing.metadata;
        }
        const count = database.prepare('SELECT count(*) AS count FROM journal_notes').get()?.[
          'count'
        ];
        if (!nonnegative(count) || count >= MAX_ROWS)
          throw new JournalOutboxError(
            'JOURNAL_OUTBOX_LIMIT',
            'The journal outbox retains at most 1000 notes, including acknowledged notes.',
          );
        database
          .prepare(
            'INSERT INTO journal_notes(note_id,api_origin,repository_id,session_id,kind,event_count,payload_json,payload_bytes,digest,queued_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            canonical.input.id,
            canonical.scope.apiOrigin,
            canonical.scope.repositoryId,
            canonical.scope.sessionId,
            canonical.input.kind,
            canonical.input.eventIds.length,
            canonical.json,
            canonical.bytes,
            canonical.digest,
            new Date().toISOString(),
          );
        return this.getFrom(database, canonical.input.id)!.metadata;
      });
    });
  }
  get(noteId: string): QueuedJournalNote | null {
    if (!id(noteId)) throw invalidInput();
    return safe(() => {
      const database = this.db();
      return transaction(database, () => this.getFrom(database, noteId), 'read');
    });
  }
  pinPrincipal(noteId: string, digest: string, peer: JournalPeer): void {
    if (!id(noteId) || !hash(digest)) throw invalidInput();
    const selected = principal(peer);
    safe(() => {
      const database = this.db();
      transaction(database, () => {
        const current = this.getFrom(database, noteId);
        if (!current)
          throw new JournalOutboxError(
            'JOURNAL_NOTE_NOT_FOUND',
            'The selected queued note is unavailable.',
          );
        if (current.digest !== digest)
          throw new JournalOutboxError(
            'IMMUTABLE_JOURNAL_CONFLICT',
            'The selected queued note does not match the immutable request.',
          );
        if (current.peer) {
          if (
            current.peer.workspaceId !== selected.workspaceId ||
            current.peer.userId !== selected.userId ||
            current.peer.workspaceGeneration !== selected.workspaceGeneration
          )
            throw new JournalOutboxError(
              'JOURNAL_PRINCIPAL_MISMATCH',
              'This queued note is pinned to a different server principal or workspace generation.',
            );
          return;
        }
        database
          .prepare(
            'UPDATE journal_notes SET peer_workspace_id=?,peer_user_id=?,peer_workspace_generation=? WHERE note_id=? AND digest=? AND peer_workspace_id IS NULL AND acknowledged_at IS NULL',
          )
          .run(selected.workspaceId, selected.userId, selected.workspaceGeneration, noteId, digest);
      });
    });
  }
  acknowledge(noteId: string, digest: string): JournalOutboxItem {
    if (!id(noteId) || !hash(digest)) throw invalidInput();
    return safe(() => {
      const database = this.db();
      return transaction(database, () => {
        const current = this.getFrom(database, noteId);
        if (!current)
          throw new JournalOutboxError(
            'JOURNAL_NOTE_NOT_FOUND',
            'The selected queued note is unavailable.',
          );
        if (current.digest !== digest)
          throw new JournalOutboxError(
            'IMMUTABLE_JOURNAL_CONFLICT',
            'The selected queued note does not match the immutable request.',
          );
        if (!current.peer)
          throw new JournalOutboxError(
            'JOURNAL_ACK_REQUIRES_PRINCIPAL',
            'Verify and pin the server principal before acknowledging a queued note.',
          );
        if (current.metadata.state === 'synced') return current.metadata;
        database
          .prepare(
            'UPDATE journal_notes SET acknowledged_at=? WHERE note_id=? AND digest=? AND acknowledged_at IS NULL',
          )
          .run(new Date().toISOString(), noteId, digest);
        return this.getFrom(database, noteId)!.metadata;
      });
    });
  }
  close(): void {
    if (!this.closed) {
      this.database?.close();
      this.database = null;
      this.closed = true;
    }
  }
}

/** Offline metadata only. It never bootstraps a store, reads config/credentials, or recovers jobs. */
export function readJournalOutboxPage(input: JournalOutboxPageQuery): JournalOutboxPage {
  if (
    !plain(input) ||
    Object.keys(input).some((key) => !['root', 'state', 'limit', 'after'].includes(key)) ||
    (input.state !== undefined && !['pending', 'synced', 'all'].includes(input.state)) ||
    (input.limit !== undefined && (!positive(input.limit) || input.limit > 50)) ||
    (input.after !== undefined && !positive(input.after))
  )
    throw invalidInput();
  const root = rootPath(input.root);
  const state = input.state ?? 'pending';
  const limit = input.limit ?? 20;
  const page = (
    exists: boolean,
    totals: JournalOutboxPage['totals'],
    items: JournalOutboxItem[],
    more: boolean,
  ): JournalOutboxPage => ({
    source: 'local_journal_outbox',
    exists,
    readOnly: true,
    totals,
    items,
    page: {
      limit,
      returnedItems: items.length,
      nextAfter: more ? items.at(-1)!.localRowId : null,
      consistency: 'live',
    },
    notice:
      'Local metadata only. Synced means an earlier validated server acknowledgement, not current server retention. Listing never uploads notes or reads note text.',
  });
  return safe(() => {
    const selected = storePath(root, true);
    if (!selected.exists) return page(false, { all: 0, pending: 0, synced: 0 }, [], false);
    const database = new DatabaseSync(selected.path, {
      readOnly: true,
      allowExtension: false,
      timeout: 5000,
    });
    try {
      database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;');
      schema(database);
      const counts = database
        .prepare(
          'SELECT count(*) AS count,coalesce(sum(acknowledged_at IS NULL),0) AS pending FROM journal_notes',
        )
        .get()!;
      if (
        !nonnegative(counts['count']) ||
        !nonnegative(counts['pending']) ||
        counts['pending'] > counts['count'] ||
        counts['count'] > MAX_ROWS
      )
        throw invalid();
      const rows = database
        .prepare(
          `SELECT ${metadataSql} FROM journal_notes WHERE 1=1${state === 'all' ? '' : state === 'pending' ? ' AND acknowledged_at IS NULL' : ' AND acknowledged_at IS NOT NULL'}${input.after === undefined ? '' : ' AND local_row_id>?'} ORDER BY local_row_id ASC LIMIT ?`,
        )
        .all(...(input.after === undefined ? [] : [input.after]), limit + 1);
      const items = rows.slice(0, limit).map(metadata);
      database.exec('COMMIT');
      return page(
        true,
        {
          all: counts['count'],
          pending: counts['pending'],
          synced: counts['count'] - counts['pending'],
        },
        items,
        rows.length > limit,
      );
    } finally {
      database.close();
    }
  });
}
