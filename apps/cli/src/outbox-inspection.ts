import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { stripVTControlCharacters } from 'node:util';
import { redactText } from '@memvora/core';
import { IdSchema } from '@memvora/contracts';
import { Check } from 'typebox/value';

export type OutboxState = 'unsynced' | 'pending' | 'incomplete' | 'synced' | 'all';
export interface OutboxInspectionRequest {
  root: string;
  state?: OutboxState;
  sessionId?: string;
  limit?: number;
  after?: number;
}
export interface OutboxInspectionItem {
  localRowId: number;
  eventId: string | null;
  sessionId: string | null;
  sequence: number | null;
  state: 'pending' | 'incomplete' | 'synced';
  metadataValid: boolean;
  repositoryId: string | null;
  executable: string | null;
  argumentsCount: number | null;
  startedAt: string | null;
  createdAt: string | null;
  payloadBytes: number | null;
}
export interface OutboxInspectionPage {
  source: 'local_outbox';
  exists: boolean;
  readOnly: true;
  notice: string;
  filter: { state: OutboxState; sessionId: string | null };
  totals: { all: number; unsynced: number; pending: number; incomplete: number; synced: number };
  items: OutboxInspectionItem[];
  page: { limit: number; returnedItems: number; nextAfter: number | null; consistency: 'live' };
}
export class OutboxInspectionError extends Error {
  constructor(
    public readonly code:
      'INVALID_OUTBOX_QUERY' | 'OUTBOX_UNAVAILABLE' | 'INVALID_OUTBOX' | 'OUTBOX_LIMIT',
    message: string,
  ) {
    super(message);
    this.name = 'OutboxInspectionError';
  }
}
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_INITIAL_BYTES = 256 * 1024;
const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
const validId = (value: unknown): value is string => Check(IdSchema, value);
const validTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const invalid = () =>
  new OutboxInspectionError(
    'INVALID_OUTBOX',
    'The existing local outbox cannot be safely inspected.',
  );

function request(input: OutboxInspectionRequest) {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) => !['root', 'state', 'sessionId', 'limit', 'after'].includes(key),
    ) ||
    typeof input.root !== 'string' ||
    !isAbsolute(input.root) ||
    /^[\\/]{2}/u.test(input.root) ||
    /[\u0000-\u001f\u007f]/u.test(input.root) ||
    (input.state !== undefined &&
      !['unsynced', 'pending', 'incomplete', 'synced', 'all'].includes(input.state)) ||
    (input.sessionId !== undefined && !validId(input.sessionId)) ||
    (input.limit !== undefined &&
      (!safeInteger(input.limit) || input.limit < 1 || input.limit > 50)) ||
    (input.after !== undefined && (!safeInteger(input.after) || input.after < 1))
  )
    throw new OutboxInspectionError(
      'INVALID_OUTBOX_QUERY',
      'Use a local root, supported state, valid session UUID and bounded page selectors.',
    );
  return {
    root: resolve(input.root),
    state: input.state ?? 'unsynced',
    sessionId: input.sessionId ?? null,
    limit: input.limit ?? 20,
    after: input.after,
  };
}
function existingFile(root: string): string | null {
  const directory = join(root, '.memvora');
  let current = parse(directory).root;
  for (const segment of relative(current, directory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalid();
  }
  const path = join(realpathSync(directory), 'outbox.sqlite');
  let size = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    let entry;
    try {
      entry = lstatSync(`${path}${suffix}`);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        if (!suffix) return null;
        continue;
      }
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw invalid();
    size += entry.size;
  }
  if (size > MAX_BYTES)
    throw new OutboxInspectionError(
      'OUTBOX_LIMIT',
      'The existing outbox exceeds the inspection size limit.',
    );
  return path;
}
function schema(database: DatabaseSync): void {
  const definition = database
    .prepare("SELECT type,sql FROM sqlite_schema WHERE name='executions'")
    .get();
  if (
    definition?.['type'] !== 'table' ||
    typeof definition['sql'] !== 'string' ||
    /\b(?:VIRTUAL|WITHOUT\s+ROWID)\b/iu.test(definition['sql'])
  )
    throw invalid();
  const columns = database.prepare('PRAGMA table_info(executions)').all();
  const required = {
    id: 'TEXT',
    session_id: 'TEXT',
    sequence: 'INTEGER',
    initial_payload: 'TEXT',
    payload: 'TEXT',
    synced: 'INTEGER',
    created_at: 'TEXT',
  };
  if (
    columns.length !== Object.keys(required).length &&
    columns.length !== Object.keys(required).length + 1
  )
    throw invalid();
  for (const [name, type] of Object.entries(required)) {
    const column = columns.find((column) => column['name'] === name);
    if (
      !column ||
      String(column['type']).toUpperCase() !== type ||
      (name === 'id' && column['pk'] !== 1)
    )
      throw invalid();
  }
  if (
    columns.some(
      (column) =>
        !Object.hasOwn(required, String(column['name'])) &&
        !(column['name'] === 'owner_pid' && String(column['type']).toUpperCase() === 'INTEGER'),
    )
  )
    throw invalid();
  if (database.prepare('SELECT 1 FROM executions WHERE rowid<=0 LIMIT 1').get()) throw invalid();
}
function cleanExecutable(value: string): string {
  const clean = redactText(
    stripVTControlCharacters(value).replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
      '',
    ),
  ).trim();
  let excerpt = '';
  for (const character of clean) {
    if (excerpt.length + character.length > 200) break;
    excerpt += character;
  }
  return excerpt;
}
function item(row: Record<string, SQLOutputValue>): OutboxInspectionItem {
  const localRowId = row['local_row_id'];
  if (!safeInteger(localRowId) || localRowId < 1) throw invalid();
  const eventId = validId(row['id']) ? row['id'] : null;
  const sessionId = validId(row['session_id']) ? row['session_id'] : null;
  const sequence = safeInteger(row['sequence']) && row['sequence'] > 0 ? row['sequence'] : null;
  const createdAt = validTime(row['created_at']) ? row['created_at'] : null;
  const state =
    row['payload_bytes'] === null ? 'incomplete' : row['synced'] === 1 ? 'synced' : 'pending';
  const result: OutboxInspectionItem = {
    localRowId,
    eventId,
    sessionId,
    sequence,
    state,
    metadataValid: false,
    repositoryId: null,
    executable: null,
    argumentsCount: null,
    startedAt: null,
    createdAt,
    payloadBytes: safeInteger(row['payload_bytes']) ? row['payload_bytes'] : null,
  };
  let initial: unknown;
  if (typeof row['initial_metadata'] !== 'string') return result;
  try {
    initial = JSON.parse(row['initial_metadata']);
  } catch {
    return result;
  }
  if (
    !object(initial) ||
    !eventId ||
    !sessionId ||
    !sequence ||
    !createdAt ||
    initial['eventId'] !== eventId ||
    initial['sessionId'] !== sessionId ||
    !validId(initial['repositoryId']) ||
    !validTime(initial['startedAt']) ||
    !object(initial['command']) ||
    typeof initial['command']['executable'] !== 'string' ||
    initial['command']['executable'].length > 4096 ||
    !Array.isArray(initial['command']['args']) ||
    initial['command']['args'].length > 256 ||
    !initial['command']['args'].every(
      (argument) => typeof argument === 'string' && argument.length <= 8192,
    ) ||
    (row['synced'] !== 0 && row['synced'] !== 1)
  )
    return result;
  const executable = cleanExecutable(initial['command']['executable']);
  if (!executable) return result;
  return {
    ...result,
    metadataValid: true,
    repositoryId: initial['repositoryId'],
    executable,
    argumentsCount: initial['command']['args'].length,
    startedAt: initial['startedAt'],
  };
}
function count(row: Record<string, SQLOutputValue> | undefined, key: string): number {
  const value = row?.[key];
  if (!safeInteger(value)) throw invalid();
  return value;
}

/** Logical read-only inspection. SQLite may manage WAL lock sidecars; no capture is recovered or modified. */
export function readExistingOutboxPage(input: OutboxInspectionRequest): OutboxInspectionPage {
  const selected = request(input); // Validation happens before any filesystem or credential access.
  const result: OutboxInspectionPage = {
    source: 'local_outbox',
    exists: false,
    readOnly: true,
    notice:
      'Local metadata only. Incomplete captures may still be active; no owner process was probed or capture recovered. Synced records a local acknowledgement, not current server retention.',
    filter: { state: selected.state, sessionId: selected.sessionId },
    totals: { all: 0, unsynced: 0, pending: 0, incomplete: 0, synced: 0 },
    items: [],
    page: { limit: selected.limit, returnedItems: 0, nextAfter: null, consistency: 'live' },
  };
  let database: DatabaseSync | undefined;
  let transaction = false;
  try {
    const path = existingFile(selected.root);
    if (path === null) return result;
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 5000 });
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;');
    transaction = true;
    schema(database);
    const session = selected.sessionId === null ? '' : ' WHERE session_id=?';
    const values = selected.sessionId === null ? [] : [selected.sessionId];
    const totals = database
      .prepare(
        `SELECT count(*) AS total,
      coalesce(sum(CASE WHEN payload IS NOT NULL AND synced=1 THEN 1 ELSE 0 END),0) AS synced,
      coalesce(sum(CASE WHEN payload IS NULL THEN 1 ELSE 0 END),0) AS incomplete,
      coalesce(sum(CASE WHEN payload IS NOT NULL AND coalesce(synced,0)!=1 THEN 1 ELSE 0 END),0) AS pending
      FROM executions${session}`,
      )
      .get(...values);
    const stateCondition = {
      all: '1',
      unsynced: '(payload IS NULL OR coalesce(synced,0)!=1)',
      pending: '(payload IS NOT NULL AND coalesce(synced,0)!=1)',
      incomplete: 'payload IS NULL',
      synced: '(payload IS NOT NULL AND synced=1)',
    }[selected.state];
    const rows = database
      .prepare(
        `SELECT rowid AS local_row_id,id,session_id,sequence,created_at,synced,
      CASE WHEN length(CAST(initial_payload AS BLOB))<=${MAX_INITIAL_BYTES} THEN initial_payload ELSE NULL END AS initial_metadata,
      CASE WHEN payload IS NULL THEN NULL ELSE length(CAST(payload AS BLOB)) END AS payload_bytes
      FROM executions WHERE ${stateCondition}${selected.sessionId === null ? '' : ' AND session_id=?'}${selected.after === undefined ? '' : ' AND rowid>?'} ORDER BY rowid ASC LIMIT ?`,
      )
      .all(
        ...values,
        ...(selected.after === undefined ? [] : [selected.after]),
        selected.limit + 1,
      );
    result.exists = true;
    result.totals = {
      all: count(totals, 'total'),
      synced: count(totals, 'synced'),
      incomplete: count(totals, 'incomplete'),
      pending: count(totals, 'pending'),
      unsynced: count(totals, 'total') - count(totals, 'synced'),
    };
    result.items = rows.slice(0, selected.limit).map(item);
    result.page = {
      limit: selected.limit,
      returnedItems: result.items.length,
      nextAfter: rows.length > selected.limit ? (result.items.at(-1)?.localRowId ?? null) : null,
      consistency: 'live',
    };
    database.exec('COMMIT');
    transaction = false;
    return result;
  } catch (error) {
    if (error instanceof OutboxInspectionError) throw error;
    throw new OutboxInspectionError(
      'OUTBOX_UNAVAILABLE',
      'The existing local outbox is unavailable or has an unsupported schema. No evidence was changed.',
    );
  } finally {
    if (transaction) {
      try {
        database?.exec('ROLLBACK');
      } catch {
        /* Preserve safe inspection errors. */
      }
    }
    try {
      database?.close();
    } catch {
      /* No raw SQLite diagnostics leave this inspector. */
    }
  }
}
