import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import {
  EventAckSchema,
  MeSchema,
  RecallAnswerSchema,
  RepositoryListSchema,
  RepositoryResponseSchema,
  SessionResponseSchema,
  type CapturedEvent,
} from '@memvora/contracts';

export interface Binding {
  schemaVersion: 1;
  repositoryId: string;
  sessionId?: string;
  apiUrl: string;
}

export const sourceProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function serverDataDir(override?: string): string {
  return resolve(
    override ?? process.env['MEMVORA_DATA_DIR'] ?? join(sourceProjectRoot, '.memvora'),
  );
}

export function readToken(home?: string): string {
  const token =
    process.env['MEMVORA_LOCAL_TOKEN'] ??
    readFileSync(join(serverDataDir(home), 'local-token'), 'utf8').trim();
  if (token.length < 32)
    throw new Error('Local API credential is missing or invalid. Start the local API first.');
  return token;
}

export function findBindingDirectory(cwd = process.cwd()): string | undefined {
  let location = resolve(cwd);
  while (true) {
    if (existsSync(join(location, '.memvora', 'config.json'))) return location;
    // A repository without a binding must not inherit an unrelated ancestor's settings.
    if (existsSync(join(location, '.git'))) return undefined;
    const parent = dirname(location);
    if (parent === location) return undefined;
    location = parent;
  }
}

export function readBinding(root: string): Binding {
  const value: unknown = JSON.parse(readFileSync(join(root, '.memvora', 'config.json'), 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('repositoryId' in value) ||
    typeof value.repositoryId !== 'string' ||
    !('apiUrl' in value) ||
    typeof value.apiUrl !== 'string'
  )
    throw new Error('Invalid local binding. Run memvora init again.');
  const binding = value as Binding;
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !id.test(binding.repositoryId) ||
    (binding.sessionId !== undefined &&
      (typeof binding.sessionId !== 'string' || !id.test(binding.sessionId)))
  )
    throw new Error('Invalid repository or session identity in local binding.');
  return binding;
}

export function writeBinding(root: string, binding: Binding): void {
  ensurePrivateDirectory(join(root, '.memvora'));
  writeFileSync(join(root, '.memvora', 'config.json'), `${JSON.stringify(binding, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Nested ignore rules protect capture data without modifying a repository's existing ignore file. */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
}

export async function apiRequest<T>(
  origin: string,
  token: string,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const url = new URL(origin);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('This local-development client only sends its token to a loopback API.');
  }
  const response = await fetch(new URL(path, url), {
    redirect: 'error',
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error =
      result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    const message =
      error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : `API returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  const schema =
    path === '/v1/me'
      ? MeSchema
      : path === '/v1/events/batch'
        ? EventAckSchema
        : path === '/v1/ask'
          ? RecallAnswerSchema
          : path === '/v1/repositories'
            ? body === undefined
              ? RepositoryListSchema
              : RepositoryResponseSchema
            : path === '/v1/sessions' || /\/v1\/sessions\/[^/]+\/close$/.test(path)
              ? SessionResponseSchema
              : undefined;
  if (schema && !Check(schema, result))
    throw new Error('API response did not match the shared contract.');
  return result as T;
}

export class LocalOutbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') ensurePrivateDirectory(dirname(resolve(path)));
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        initial_payload TEXT NOT NULL, payload TEXT, synced INTEGER NOT NULL DEFAULT 0, owner_pid INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS output_chunks (
        event_id TEXT NOT NULL, ordinal INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(event_id, ordinal));`);
    // Serialize the additive migration with other CLI processes opening this outbox.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        !this.db
          .prepare('PRAGMA table_info(executions)')
          .all()
          .some((column) => column['name'] === 'owner_pid')
      )
        this.db.exec('ALTER TABLE executions ADD COLUMN owner_pid INTEGER');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  begin(eventId: string, sessionId: string, initialPayload: unknown): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO sessions(id) VALUES(?) ON CONFLICT DO NOTHING').run(sessionId);
      const row = this.db.prepare('SELECT next_sequence FROM sessions WHERE id=?').get(sessionId);
      const sequence = Number(row?.['next_sequence']);
      this.db
        .prepare('UPDATE sessions SET next_sequence=next_sequence+1 WHERE id=?')
        .run(sessionId);
      this.db
        .prepare(
          'INSERT INTO executions(id,session_id,sequence,initial_payload,owner_pid) VALUES(?,?,?,?,?)',
        )
        .run(eventId, sessionId, sequence, JSON.stringify(initialPayload), process.pid);
      this.db.exec('COMMIT');
      return sequence;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  append(eventId: string, ordinal: number, stream: 'stdout' | 'stderr', text: string): void {
    this.db
      .prepare('INSERT INTO output_chunks(event_id,ordinal,stream,text) VALUES(?,?,?,?)')
      .run(eventId, ordinal, stream, text);
  }

  output(eventId: string): CapturedEvent['output'] {
    return this.db
      .prepare('SELECT ordinal,stream,text FROM output_chunks WHERE event_id=? ORDER BY ordinal')
      .all(eventId)
      .map((row) => {
        const stream = row['stream'];
        if (stream !== 'stdout' && stream !== 'stderr')
          throw new Error('Stored output has an invalid stream identifier.');
        return { ordinal: Number(row['ordinal']), stream, text: String(row['text']) };
      });
  }

  finalize(eventId: string, payload: unknown): void {
    this.db
      .prepare('UPDATE executions SET payload=? WHERE id=? AND payload IS NULL')
      .run(JSON.stringify(payload), eventId);
  }

  incomplete(): Array<{
    eventId: string;
    sequence: number;
    ownerPid: number | null;
    initial: Record<string, unknown>;
  }> {
    return this.db
      .prepare('SELECT id,sequence,owner_pid,initial_payload FROM executions WHERE payload IS NULL')
      .all()
      .map((row) => ({
        eventId: String(row['id']),
        sequence: Number(row['sequence']),
        ownerPid: row['owner_pid'] === null ? null : Number(row['owner_pid']),
        initial: JSON.parse(String(row['initial_payload'])) as Record<string, unknown>,
      }));
  }

  pending(): Array<{ eventId: string; payload: Record<string, unknown> }> {
    const rows = this.db
      .prepare(
        'SELECT id,payload FROM executions WHERE synced=0 AND payload IS NOT NULL ORDER BY created_at,id LIMIT 50',
      )
      .all();
    let bytes = 128;
    const selected: Array<{ eventId: string; payload: Record<string, unknown> }> = [];
    for (const row of rows) {
      const payload = String(row['payload']);
      const size = Buffer.byteLength(payload, 'utf8') + 1;
      if (bytes + size > 1_900_000) break;
      bytes += size;
      selected.push({
        eventId: String(row['id']),
        payload: JSON.parse(payload) as Record<string, unknown>,
      });
    }
    if (rows.length && !selected.length)
      throw new Error('A pending event exceeds the upload limit; it remains stored locally.');
    return selected;
  }

  acknowledge(ids: readonly string[], uploadedIds: readonly string[]): void {
    const allowed = new Set(uploadedIds);
    if (ids.some((id) => !allowed.has(id)))
      throw new Error('API acknowledged an event outside the uploaded batch.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids)
        this.db
          .prepare('UPDATE executions SET synced=1 WHERE id=? AND payload IS NOT NULL')
          .run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  counts(): { pending: number; incomplete: number } {
    const row = this.db
      .prepare(
        'SELECT SUM(CASE WHEN synced=0 AND payload IS NOT NULL THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN payload IS NULL THEN 1 ELSE 0 END) AS incomplete FROM executions',
      )
      .get();
    return { pending: Number(row?.['pending'] ?? 0), incomplete: Number(row?.['incomplete'] ?? 0) };
  }

  close(): void {
    this.db.close();
  }
}
