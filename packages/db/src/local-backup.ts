import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export const LOCAL_BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 32 * 1024;
const DATABASE_SCHEMA = 7;
const countQueries = {
  repositories: 'SELECT count(*) AS count FROM local_repositories',
  sessions: 'SELECT count(*) AS count FROM local_sessions',
  events: 'SELECT count(*) AS count FROM local_events',
  memories: 'SELECT count(*) AS count FROM local_memories',
  notes: 'SELECT count(*) AS count FROM local_session_notes',
  repositorySources: 'SELECT count(*) AS count FROM local_repository_sources',
  jobs: 'SELECT count(*) AS count FROM local_jobs',
  eventIntakes: 'SELECT count(*) AS count FROM local_event_intakes',
  deletedWorkspaces: "SELECT count(*) AS count FROM local_workspaces WHERE status='deleted'",
  deletedRepositories: "SELECT count(*) AS count FROM local_repositories WHERE status='deleted'",
  deletedSessions: "SELECT count(*) AS count FROM local_sessions WHERE status='deleted'",
} as const;
type BackupCounts = { [Key in keyof typeof countQueries]: number };
const contents = {
  encryptedGitHubState: 'retained',
  localApiCredential: 'excluded',
  environment: 'excluded',
  cliOutboxes: 'excluded',
} as const;

export interface LocalBackupManifest {
  format: 'memvora-local-backup';
  schemaVersion: 1;
  createdAt: string;
  database: {
    file: 'server.sqlite';
    schemaVersion: 7;
    byteLength: number;
    sha256: string;
  };
  counts: BackupCounts;
  contents: typeof contents;
}

export type LocalBackupErrorCode =
  | 'INVALID_BACKUP_PATH'
  | 'BACKUP_SOURCE_INVALID'
  | 'BACKUP_TARGET_EXISTS'
  | 'BACKUP_LIMIT'
  | 'BACKUP_INVALID'
  | 'UNSUPPORTED_BACKUP_SCHEMA'
  | 'BACKUP_FAILED';

/** Errors deliberately omit SQLite diagnostics, credentials and evidence content. */
export class LocalBackupError extends Error {
  constructor(
    public readonly code: LocalBackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalBackupError';
  }
}
const invalid = () =>
  new LocalBackupError('BACKUP_INVALID', 'The backup is incomplete or invalid.');
const sourceInvalid = () =>
  new LocalBackupError('BACKUP_SOURCE_INVALID', 'The existing local evidence database is invalid.');

function absolutePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !isAbsolute(value) ||
    /^[\\/]{2}/u.test(value)
  )
    throw new LocalBackupError('INVALID_BACKUP_PATH', 'Use an absolute local filesystem path.');
  return resolve(value);
}

/** A backup must not follow links or junctions through any existing path component. */
function regularDirectory(path: string): string {
  let component = parse(path).root;
  for (const segment of relative(component, path).split(sep).filter(Boolean)) {
    component = join(component, segment);
    const entry = lstatSync(component);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new LocalBackupError(
        'INVALID_BACKUP_PATH',
        'Backup paths must use regular local directories.',
      );
  }
  return realpathSync(path);
}

function regularFile(path: string, maximum: number): number {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw invalid();
  if (entry.size < 1 || entry.size > maximum)
    throw new LocalBackupError('BACKUP_LIMIT', 'The backup exceeds the supported size limit.');
  return entry.size;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key)),
  );
}
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function manifestValue(value: unknown): LocalBackupManifest {
  if (
    !exactKeys(value, ['format', 'schemaVersion', 'createdAt', 'database', 'counts', 'contents']) ||
    value['format'] !== 'memvora-local-backup' ||
    value['schemaVersion'] !== 1 ||
    !timestamp(value['createdAt']) ||
    !exactKeys(value['database'], ['file', 'schemaVersion', 'byteLength', 'sha256']) ||
    value['database']['file'] !== 'server.sqlite' ||
    value['database']['schemaVersion'] !== DATABASE_SCHEMA ||
    !integer(value['database']['byteLength']) ||
    value['database']['byteLength'] < 1 ||
    value['database']['byteLength'] > LOCAL_BACKUP_MAX_BYTES ||
    typeof value['database']['sha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value['database']['sha256']) ||
    !exactKeys(value['counts'], Object.keys(countQueries)) ||
    !Object.values(value['counts']).every(integer) ||
    !exactKeys(value['contents'], Object.keys(contents)) ||
    !Object.entries(contents).every(
      ([key, expected]) => (value['contents'] as Record<string, unknown>)[key] === expected,
    )
  )
    throw invalid();
  return value as unknown as LocalBackupManifest;
}

const requiredColumns = {
  local_identity: ['singleton', 'user_id', 'display_name'],
  local_workspaces: ['id', 'owner_user_id', 'name', 'generation', 'status', 'created_at'],
  local_repositories: [
    'id',
    'workspace_id',
    'name',
    'local_path',
    'remote_url',
    'generation',
    'status',
    'created_at',
  ],
  local_sessions: [
    'id',
    'workspace_id',
    'repository_id',
    'title',
    'generation',
    'status',
    'created_at',
    'closed_at',
  ],
  local_repository_context: ['repository_id', 'context_json', 'imported_at'],
  local_repository_context_scope: [
    'repository_id',
    'workspace_generation',
    'repository_generation',
  ],
  local_events: [
    'id',
    'workspace_id',
    'repository_id',
    'session_id',
    'sequence',
    'digest',
    'payload_json',
    'received_at',
  ],
  local_jobs: [
    'id',
    'event_id',
    'workspace_id',
    'repository_id',
    'session_id',
    'workspace_generation',
    'repository_generation',
    'session_generation',
    'status',
    'attempts',
    'available_at',
    'lease_until',
    'lease_token',
    'last_error',
    'retry_count',
  ],
  local_memories: [
    'id',
    'event_id',
    'workspace_id',
    'repository_id',
    'session_id',
    'title',
    'summary_json',
    'searchable_text',
    'created_at',
  ],
  local_repository_sources: [
    'id',
    'workspace_id',
    'repository_id',
    'workspace_generation',
    'repository_generation',
    'full_name',
    'path',
    'commit_sha',
    'commit_key',
    'blob_sha',
    'content_hash',
    'text',
    'line_count',
    'imported_at',
  ],
  local_repository_source_heads: ['repository_id', 'path', 'source_id'],
  local_event_intakes: ['id', 'event_id'],
  local_history_state: ['singleton', 'cursor_secret'],
  local_github_connections: [
    'workspace_id',
    'user_id',
    'workspace_generation',
    'revision',
    'github_user_id',
    'github_user_json',
    'config_hash',
    'encrypted_tokens',
    'expires_at',
    'updated_at',
  ],
  local_github_oauth_attempts: [
    'workspace_id',
    'user_id',
    'workspace_generation',
    'state_hash',
    'browser_hash',
    'encrypted_verifier',
    'config_hash',
    'expires_at',
    'expected_revision',
  ],
  local_session_notes: [
    'ordinal',
    'id',
    'workspace_id',
    'repository_id',
    'session_id',
    'workspace_generation',
    'repository_generation',
    'session_generation',
    'digest',
    'kind',
    'body',
    'author_id',
    'author_name',
    'event_ids_json',
    'created_at',
  ],
  local_memory_fts: ['memory_id', 'searchable_text'],
  local_repository_source_fts: ['source_id', 'searchable_text'],
  local_session_note_fts: ['note_id', 'body'],
} as const;
const ftsTables = ['local_memory_fts', 'local_repository_source_fts', 'local_session_note_fts'];
const knownTables = new Set([
  ...Object.keys(requiredColumns),
  'sqlite_sequence',
  ...ftsTables.flatMap((table) =>
    ['data', 'idx', 'content', 'docsize', 'config'].map((suffix) => `${table}_${suffix}`),
  ),
]);

function scalar(database: DatabaseSync, sql: string): number {
  const value = database.prepare(sql).get()?.['count'];
  if (!integer(value)) throw invalid();
  return value;
}

function checkSchema(database: DatabaseSync): void {
  if (database.prepare('PRAGMA user_version').get()?.['user_version'] !== DATABASE_SCHEMA)
    throw new LocalBackupError(
      'UNSUPPORTED_BACKUP_SCHEMA',
      'Only the current local database schema can be backed up or verified.',
    );
  const objects = database
    .prepare("SELECT name,type,sql FROM sqlite_schema WHERE type IN ('table','view')")
    .all();
  if (
    objects.length !== knownTables.size ||
    objects.some((object) => object['type'] !== 'table' || !knownTables.has(String(object['name'])))
  )
    throw invalid();
  for (const [table, expected] of Object.entries(requiredColumns)) {
    // Table names are compile-time constants, never derived from a file or manifest.
    const columns = database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => String(column['name']));
    if (columns.length !== expected.length || !expected.every((column) => columns.includes(column)))
      throw invalid();
  }
  for (const table of ftsTables) {
    const definition = objects.find((object) => object['name'] === table)?.['sql'];
    if (typeof definition !== 'string' || !/\bUSING\s+fts5\s*\(/iu.test(definition))
      throw invalid();
  }
}

function inspect(database: DatabaseSync): BackupCounts {
  checkSchema(database);
  if (
    database.prepare('PRAGMA integrity_check(1)').get()?.['integrity_check'] !== 'ok' ||
    database.prepare('PRAGMA foreign_key_check').get()
  )
    throw invalid();
  const identities = database.prepare('SELECT singleton,user_id FROM local_identity LIMIT 2').all();
  const history = database
    .prepare('SELECT singleton,cursor_secret FROM local_history_state LIMIT 2')
    .all();
  if (
    identities.length !== 1 ||
    identities[0]?.['singleton'] !== 1 ||
    !id(identities[0]?.['user_id']) ||
    history.length !== 1 ||
    history[0]?.['singleton'] !== 1 ||
    typeof history[0]?.['cursor_secret'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(history[0]['cursor_secret'])
  )
    throw invalid();
  const workspaces = database
    .prepare('SELECT id,owner_user_id,generation,status FROM local_workspaces LIMIT 1001')
    .all();
  if (
    !workspaces.length ||
    workspaces.length > 1000 ||
    !workspaces.some((workspace) => workspace['owner_user_id'] === identities[0]?.['user_id']) ||
    workspaces.some(
      (workspace) =>
        !id(workspace['id']) ||
        !id(workspace['owner_user_id']) ||
        !integer(workspace['generation']) ||
        workspace['generation'] < 1 ||
        !['active', 'deleted'].includes(String(workspace['status'])),
    )
  )
    throw invalid();
  for (const [table, allowed] of [
    ['local_repositories', "'active','deleted'"],
    ['local_sessions', "'open','closed','deleted'"],
  ] as const) {
    if (
      database
        .prepare(
          `SELECT 1 FROM ${table} WHERE generation<1 OR generation>9007199254740991 OR status NOT IN (${allowed}) LIMIT 1`,
        )
        .get()
    )
      throw invalid();
  }
  if (
    database
      .prepare(
        'SELECT 1 FROM local_events e LEFT JOIN local_event_intakes i ON i.event_id=e.id WHERE i.id IS NULL LIMIT 1',
      )
      .get()
  )
    throw invalid();
  for (const [table, column] of [
    ['local_event_intakes', 'id'],
    ['local_session_notes', 'ordinal'],
  ] as const) {
    const maximum = scalar(database, `SELECT coalesce(max(${column}),0) AS count FROM ${table}`);
    const sequence =
      database.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.['seq'] ?? 0;
    if (!integer(sequence) || sequence < maximum) throw invalid();
  }
  return Object.fromEntries(
    Object.entries(countQueries).map(([key, sql]) => [key, scalar(database, sql)]),
  ) as BackupCounts;
}

function openReadOnly(path: string): DatabaseSync {
  const database = new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
    timeout: 5_000,
  });
  try {
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += (chunk as Buffer).length;
    if (bytes > LOCAL_BACKUP_MAX_BYTES)
      throw new LocalBackupError('BACKUP_LIMIT', 'The backup exceeds the supported size limit.');
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function completedFiles(directory: string): void {
  const entries = readdirSync(directory).sort();
  if (entries.join('\0') !== ['.gitignore', 'manifest.json', 'server.sqlite'].sort().join('\0'))
    throw invalid();
  regularFile(join(directory, '.gitignore'), 16);
  if (readFileSync(join(directory, '.gitignore'), 'utf8') !== '*\n') throw invalid();
  regularFile(join(directory, 'manifest.json'), MANIFEST_MAX_BYTES);
  regularFile(join(directory, 'server.sqlite'), LOCAL_BACKUP_MAX_BYTES);
}

/** Filesystem-only preflight before the operator creates its default backup parent. */
export function resolveLocalBackupDataDirectory(input: string): string {
  try {
    const directory = regularDirectory(absolutePath(input));
    regularFile(join(directory, 'server.sqlite'), LOCAL_BACKUP_MAX_BYTES);
    return directory;
  } catch (error) {
    if (error instanceof LocalBackupError) throw error;
    throw sourceInvalid();
  }
}

/** No source credential read, schema migration, worker, provider request or live restore. */
export async function createLocalBackup(options: {
  dataDirectory: string;
  outputDirectory: string;
}): Promise<{ directory: string; manifest: LocalBackupManifest }> {
  let source: DatabaseSync | undefined;
  try {
    if (!exactKeys(options, ['dataDirectory', 'outputDirectory']))
      throw new LocalBackupError(
        'INVALID_BACKUP_PATH',
        'Specify a source data directory and a new local output directory.',
      );
    const dataDirectory = resolveLocalBackupDataDirectory(options.dataDirectory);
    const requestedOutput = absolutePath(options.outputDirectory);
    const parent = regularDirectory(dirname(requestedOutput));
    const directory = join(parent, parse(requestedOutput).base);
    const sourcePath = join(dataDirectory, 'server.sqlite');
    let inputBytes = regularFile(sourcePath, LOCAL_BACKUP_MAX_BYTES);
    for (const suffix of ['-wal', '-shm']) {
      try {
        const entry = lstatSync(`${sourcePath}${suffix}`);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw sourceInvalid();
        inputBytes += entry.size;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
          throw error;
      }
    }
    if (inputBytes > LOCAL_BACKUP_MAX_BYTES)
      throw new LocalBackupError(
        'BACKUP_LIMIT',
        'The source database exceeds the supported size limit.',
      );
    source = openReadOnly(sourcePath);
    checkSchema(source);
    const pageCount = source.prepare('PRAGMA page_count').get()?.['page_count'];
    const pageSize = source.prepare('PRAGMA page_size').get()?.['page_size'];
    if (!integer(pageCount) || !integer(pageSize) || pageCount * pageSize > LOCAL_BACKUP_MAX_BYTES)
      throw new LocalBackupError(
        'BACKUP_LIMIT',
        'The source database exceeds the supported size limit.',
      );
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
        throw new LocalBackupError(
          'BACKUP_TARGET_EXISTS',
          'The backup destination already exists; choose a new directory.',
        );
      throw error;
    }
    writeFileSync(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    const destination = join(directory, 'server.sqlite');
    // Reserve a regular private target before SQLite opens it. The new directory is exclusively claimed.
    writeFileSync(destination, '', { flag: 'wx', mode: 0o600 });
    await backup(source, destination, { rate: 100 });
    // A single-file artifact must not depend on WAL sidecars. Only this exclusively owned
    // copy changes journal metadata; source tables, identities and cursor state are untouched.
    const ownedCopy = new DatabaseSync(destination, { allowExtension: false, timeout: 5_000 });
    try {
      const mode = ownedCopy.prepare('PRAGMA journal_mode=DELETE').get()?.['journal_mode'];
      if (mode !== 'delete') throw invalid();
      ownedCopy.exec('PRAGMA synchronous=FULL;');
    } finally {
      ownedCopy.close();
    }
    chmodSync(destination, 0o600);
    const byteLength = regularFile(destination, LOCAL_BACKUP_MAX_BYTES);
    const snapshot = openReadOnly(destination);
    let counts: BackupCounts;
    try {
      counts = inspect(snapshot);
    } finally {
      snapshot.close();
    }
    if (
      readdirSync(directory).sort().join('\0') !== ['.gitignore', 'server.sqlite'].sort().join('\0')
    )
      throw invalid();
    const manifest: LocalBackupManifest = {
      format: 'memvora-local-backup',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      database: {
        file: 'server.sqlite',
        schemaVersion: 7,
        byteLength,
        sha256: await sha256(destination),
      },
      counts,
      contents: { ...contents },
    };
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { directory, manifest };
  } catch (error) {
    if (error instanceof LocalBackupError) throw error;
    throw new LocalBackupError(
      'BACKUP_FAILED',
      'Backup creation failed. Any newly created incomplete directory was retained.',
    );
  } finally {
    source?.close();
  }
}

/** Verification reads fixed files only and does not migrate or restore the database. */
export async function verifyLocalBackup(input: string): Promise<LocalBackupManifest> {
  let snapshot: DatabaseSync | undefined;
  try {
    const directory = regularDirectory(absolutePath(input));
    completedFiles(directory);
    const manifest = manifestValue(
      JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')),
    );
    const path = join(directory, 'server.sqlite');
    if (
      regularFile(path, LOCAL_BACKUP_MAX_BYTES) !== manifest.database.byteLength ||
      (await sha256(path)) !== manifest.database.sha256
    )
      throw invalid();
    snapshot = openReadOnly(path);
    const counts = inspect(snapshot);
    snapshot.close();
    snapshot = undefined;
    completedFiles(directory);
    if (
      !Object.entries(counts).every(
        ([key, count]) => manifest.counts[key as keyof BackupCounts] === count,
      )
    )
      throw invalid();
    return manifest;
  } catch (error) {
    if (error instanceof LocalBackupError) throw error;
    throw invalid();
  } finally {
    snapshot?.close();
  }
}
