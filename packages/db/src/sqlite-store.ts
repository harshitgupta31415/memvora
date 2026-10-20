import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type {
  CapturedEvent,
  CreateRepository,
  CreateSession,
  Dashboard,
  JobsQuery,
  JobSummary,
  LocalContext,
  Memory,
  Repository,
  RepositoryContext,
  SearchRequest,
  Session,
  SessionContext,
} from '@memvora/contracts';
import { DomainError, newId, redactText } from '@memvora/core';
import type { AcceptedEvent, EnrichmentJob, LocalEvidenceStore } from '@memvora/core';
import { localFtsMigrationSql, localRetryMigrationSql, localSchemaSql } from './sqlite-schema.js';

type Row = Record<string, SQLOutputValue>;
const string = (row: Row, key: string): string => String(row[key]);
const integer = (row: Row, key: string): number => Number(row[key]);
const nullable = (row: Row, key: string): string | null =>
  row[key] == null ? null : String(row[key]);
const notFound = () =>
  new DomainError('NOT_FOUND', 'The requested resource is not available in this workspace.', 404);
const now = () => new Date().toISOString();
const parse = <T>(value: SQLOutputValue | undefined): T => JSON.parse(String(value)) as T;

/** Synchronous, bounded local adapter. Do not use as a hosted multi-user database. */
export class SqliteEvidenceStore implements LocalEvidenceStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.path, { timeout: 5_000 });
    const version = this.one('PRAGMA user_version');
    if (version && integer(version, 'user_version') > 3) {
      this.database.close();
      throw new Error('Local database schema is newer than this application.');
    }
    this.database.exec(localSchemaSql);
    this.transaction(() => {
      // Re-read after BEGIN IMMEDIATE: another process may have migrated while this one waited.
      const currentVersion = integer(this.one('PRAGMA user_version') ?? {}, 'user_version');
      if (currentVersion > 3)
        throw new Error('Local database schema is newer than this application.');
      if (currentVersion < 2) {
        this.database.exec(localFtsMigrationSql);
      }
      if (currentVersion < 3) this.database.exec(localRetryMigrationSql);
    });
    this.transaction(() => {
      if (!this.one('SELECT user_id FROM local_identity WHERE singleton=1')) {
        const userId = newId();
        this.run(
          'INSERT INTO local_identity(singleton,user_id,display_name) VALUES(1,?,?)',
          userId,
          'Local developer',
        );
        this.run(
          'INSERT INTO local_workspaces(id,owner_user_id,name,created_at) VALUES(?,?,?,?)',
          newId(),
          userId,
          'Personal workspace',
          now(),
        );
      }
    });
  }

  private one(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.database.prepare(sql).get(...values);
  }
  private rows(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.database.prepare(sql).all(...values);
  }
  private run(sql: string, ...values: SQLInputValue[]) {
    return this.database.prepare(sql).run(...values);
  }
  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  private requireContext(context: LocalContext): void {
    if (
      !this.one(
        "SELECT id FROM local_workspaces WHERE id=? AND owner_user_id=? AND generation=? AND status='active'",
        context.workspace.id,
        context.user.id,
        context.workspace.generation,
      )
    )
      throw new DomainError(
        'WORKSPACE_UNAVAILABLE',
        'The local workspace is deleted or no longer available.',
        403,
      );
  }
  private repositoryRow(context: LocalContext, id: string): Row {
    this.requireContext(context);
    const row = this.one(
      "SELECT r.* FROM local_repositories r JOIN local_workspaces w ON w.id=r.workspace_id WHERE r.id=? AND r.workspace_id=? AND r.status='active' AND w.status='active' AND w.generation=? AND w.owner_user_id=?",
      id,
      context.workspace.id,
      context.workspace.generation,
      context.user.id,
    );
    if (!row) throw notFound();
    return row;
  }
  private sessionRow(context: LocalContext, id: string): Row {
    this.requireContext(context);
    const row = this.one(
      "SELECT s.* FROM local_sessions s JOIN local_repositories r ON r.id=s.repository_id JOIN local_workspaces w ON w.id=s.workspace_id WHERE s.id=? AND s.workspace_id=? AND s.status!='deleted' AND r.status='active' AND r.workspace_id=s.workspace_id AND w.status='active' AND w.generation=? AND w.owner_user_id=?",
      id,
      context.workspace.id,
      context.workspace.generation,
      context.user.id,
    );
    if (!row) throw notFound();
    return row;
  }
  private repositoryDto(row: Row): Repository {
    return {
      id: string(row, 'id'),
      workspaceId: string(row, 'workspace_id'),
      name: string(row, 'name'),
      localPath: nullable(row, 'local_path'),
      remoteUrl: nullable(row, 'remote_url'),
      status: 'active',
      createdAt: string(row, 'created_at'),
    };
  }
  private sessionDto(row: Row): Session {
    const id = string(row, 'id');
    return {
      id,
      repositoryId: string(row, 'repository_id'),
      title: string(row, 'title'),
      status: row['status'] === 'closed' ? 'closed' : 'open',
      createdAt: string(row, 'created_at'),
      closedAt: nullable(row, 'closed_at'),
      eventCount: integer(
        this.one(
          'SELECT count(*) AS count FROM local_events WHERE session_id=? AND workspace_id=?',
          id,
          string(row, 'workspace_id'),
        ) ?? {},
        'count',
      ),
      memoryCount: integer(
        this.one(
          'SELECT count(*) AS count FROM local_memories WHERE session_id=? AND workspace_id=?',
          id,
          string(row, 'workspace_id'),
        ) ?? {},
        'count',
      ),
    };
  }

  context(): LocalContext {
    const row = this.one(
      'SELECT i.user_id,i.display_name,w.id,w.name,w.generation,w.status FROM local_identity i JOIN local_workspaces w ON w.owner_user_id=i.user_id WHERE i.singleton=1 ORDER BY w.created_at LIMIT 1',
    );
    if (!row || row['status'] !== 'active')
      throw new DomainError(
        'WORKSPACE_UNAVAILABLE',
        'The local workspace was deleted. It will not be recreated automatically.',
        403,
      );
    return {
      mode: 'local',
      user: { id: string(row, 'user_id'), name: string(row, 'display_name') },
      workspace: {
        id: string(row, 'id'),
        name: string(row, 'name'),
        generation: integer(row, 'generation'),
      },
    };
  }
  repositories(context: LocalContext): Repository[] {
    this.requireContext(context);
    return this.rows(
      "SELECT * FROM local_repositories WHERE workspace_id=? AND status='active' ORDER BY created_at DESC LIMIT 100",
      context.workspace.id,
    ).map((row) => this.repositoryDto(row));
  }
  createRepository(context: LocalContext, input: CreateRepository): Repository {
    return this.transaction(() => {
      this.requireContext(context);
      const name = redactText(input.name.trim());
      if (!name) throw new DomainError('INVALID_NAME', 'Repository name cannot be empty.');
      const localPath = input.localPath ? redactText(input.localPath.trim()) : null;
      const remoteUrl = input.remoteUrl ? redactText(input.remoteUrl.trim()) : null;
      const existing = localPath
        ? this.one(
            "SELECT * FROM local_repositories WHERE workspace_id=? AND local_path=? AND status='active'",
            context.workspace.id,
            localPath,
          )
        : remoteUrl
          ? this.one(
              "SELECT * FROM local_repositories WHERE workspace_id=? AND remote_url=? AND status='active'",
              context.workspace.id,
              remoteUrl,
            )
          : undefined;
      if (existing) return this.repositoryDto(existing);
      const id = newId();
      this.run(
        'INSERT INTO local_repositories(id,workspace_id,name,local_path,remote_url,created_at) VALUES(?,?,?,?,?,?)',
        id,
        context.workspace.id,
        name,
        localPath,
        remoteUrl,
        now(),
      );
      return this.repositoryDto(this.repositoryRow(context, id));
    });
  }
  getRepository(context: LocalContext, id: string): Repository {
    return this.repositoryDto(this.repositoryRow(context, id));
  }
  saveRepositoryContext(context: LocalContext, id: string, value: RepositoryContext): void {
    this.transaction(() => {
      this.repositoryRow(context, id);
      const json = JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'string' ? redactText(item) : item,
      );
      if (Buffer.byteLength(json) > 2 * 1024 * 1024)
        throw new DomainError(
          'CONTEXT_LIMIT',
          'Repository context exceeds the 2 MiB local import limit.',
          413,
        );
      this.run(
        'INSERT INTO local_repository_context(repository_id,context_json,imported_at) VALUES(?,?,?) ON CONFLICT(repository_id) DO UPDATE SET context_json=excluded.context_json,imported_at=excluded.imported_at',
        id,
        json,
        value.importedAt,
      );
    });
  }
  getRepositoryContext(context: LocalContext, id: string): RepositoryContext | null {
    this.repositoryRow(context, id);
    const row = this.one(
      'SELECT context_json FROM local_repository_context WHERE repository_id=?',
      id,
    );
    return row ? parse<RepositoryContext>(row['context_json']) : null;
  }
  sessions(context: LocalContext, repositoryId?: string, limit = 50): Session[] {
    this.requireContext(context);
    if (repositoryId) this.repositoryRow(context, repositoryId);
    const rows = this.rows(
      `SELECT s.* FROM local_sessions s JOIN local_repositories r ON r.id=s.repository_id WHERE s.workspace_id=? AND s.status!='deleted' AND r.status='active'${repositoryId ? ' AND s.repository_id=?' : ''} ORDER BY s.created_at DESC,s.id DESC LIMIT ?`,
      context.workspace.id,
      ...(repositoryId ? [repositoryId] : []),
      Math.min(Math.max(limit, 1), 100),
    );
    return rows.map((row) => this.sessionDto(row));
  }
  createSession(context: LocalContext, input: CreateSession): Session {
    return this.transaction(() => {
      this.repositoryRow(context, input.repositoryId);
      const title = redactText(input.title?.trim() || 'Investigation');
      const id = newId();
      this.run(
        'INSERT INTO local_sessions(id,workspace_id,repository_id,title,created_at) VALUES(?,?,?,?,?)',
        id,
        context.workspace.id,
        input.repositoryId,
        title,
        now(),
      );
      return this.sessionDto(this.sessionRow(context, id));
    });
  }
  getSession(context: LocalContext, id: string): SessionContext {
    const session = this.sessionDto(this.sessionRow(context, id));
    const events = this.rows(
      'SELECT payload_json FROM (SELECT payload_json,sequence FROM local_events WHERE workspace_id=? AND session_id=? ORDER BY sequence DESC LIMIT 100) ORDER BY sequence ASC',
      context.workspace.id,
      id,
    ).map((row) => parse<CapturedEvent>(row['payload_json']));
    const memories = this.rows(
      'SELECT summary_json FROM (SELECT m.summary_json,e.sequence FROM local_memories m JOIN local_events e ON e.id=m.event_id WHERE m.workspace_id=? AND m.session_id=? ORDER BY e.sequence DESC LIMIT 100) ORDER BY sequence ASC',
      context.workspace.id,
      id,
    ).map((row) => parse<Memory>(row['summary_json']));
    return { session, events, memories };
  }
  closeSession(context: LocalContext, id: string): Session {
    return this.transaction(() => {
      this.sessionRow(context, id);
      this.run(
        "UPDATE local_sessions SET status='closed',closed_at=coalesce(closed_at,?) WHERE id=? AND workspace_id=?",
        now(),
        id,
        context.workspace.id,
      );
      return this.sessionDto(this.sessionRow(context, id));
    });
  }
  getEvent(context: LocalContext, id: string): CapturedEvent {
    this.requireContext(context);
    const row = this.one(
      "SELECT e.payload_json FROM local_events e JOIN local_sessions s ON s.id=e.session_id JOIN local_repositories r ON r.id=e.repository_id JOIN local_workspaces w ON w.id=e.workspace_id WHERE e.id=? AND e.workspace_id=? AND s.status!='deleted' AND r.status='active' AND w.status='active' AND w.generation=?",
      id,
      context.workspace.id,
      context.workspace.generation,
    );
    if (!row) throw notFound();
    return parse<CapturedEvent>(row['payload_json']);
  }
  neighborEvents(context: LocalContext, eventId: string, radius = 3): CapturedEvent[] {
    const source = this.getEvent(context, eventId);
    const distance = Number.isFinite(radius) ? Math.min(Math.max(Math.trunc(radius), 0), 3) : 0;
    return this.rows(
      "SELECT e.payload_json FROM local_events e JOIN local_sessions s ON s.id=e.session_id JOIN local_repositories r ON r.id=e.repository_id JOIN local_workspaces w ON w.id=e.workspace_id WHERE e.workspace_id=? AND e.repository_id=? AND e.session_id=? AND e.sequence BETWEEN ? AND ? AND s.status!='deleted' AND r.status='active' AND w.status='active' AND w.generation=? AND w.owner_user_id=? ORDER BY e.sequence ASC LIMIT 7",
      context.workspace.id,
      source.repositoryId,
      source.sessionId,
      Math.max(source.sequence - distance, 1),
      source.sequence + distance,
      context.workspace.generation,
      context.user.id,
    ).map((row) => parse<CapturedEvent>(row['payload_json']));
  }
  recentSession(context: LocalContext, repositoryIds?: string[]): SessionContext | null {
    this.requireContext(context);
    const ids = repositoryIds ? [...new Set(repositoryIds)] : undefined;
    if (ids) {
      for (const id of ids) this.repositoryRow(context, id);
      if (!ids.length) return null;
    }
    const row = this.one(
      `SELECT e.session_id FROM local_events e JOIN local_sessions s ON s.id=e.session_id JOIN local_repositories r ON r.id=e.repository_id JOIN local_workspaces w ON w.id=e.workspace_id WHERE e.workspace_id=? AND s.status!='deleted' AND r.status='active' AND w.status='active' AND w.generation=? AND w.owner_user_id=?${ids ? ` AND e.repository_id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY e.received_at DESC,e.rowid DESC LIMIT 1`,
      context.workspace.id,
      context.workspace.generation,
      context.user.id,
      ...(ids ?? []),
    );
    return row ? this.getSession(context, string(row, 'session_id')) : null;
  }
  ingest(context: LocalContext, events: AcceptedEvent[]): string[] {
    return this.transaction(() => {
      this.requireContext(context);
      for (const { event, digest } of events) {
        const repository = this.repositoryRow(context, event.repositoryId);
        const session = this.sessionRow(context, event.sessionId);
        if (session['repository_id'] !== event.repositoryId) throw notFound();
        const existing = this.one(
          'SELECT digest,workspace_id FROM local_events WHERE id=?',
          event.eventId,
        );
        if (existing) {
          if (existing['workspace_id'] !== context.workspace.id) throw notFound();
          if (existing['digest'] !== digest)
            throw new DomainError(
              'IMMUTABLE_EVENT_CONFLICT',
              'An event ID was reused with different evidence.',
              409,
            );
          continue;
        }
        if (
          this.one(
            'SELECT id FROM local_events WHERE session_id=? AND sequence=?',
            event.sessionId,
            event.sequence,
          )
        )
          throw new DomainError(
            'SEQUENCE_CONFLICT',
            'This session sequence belongs to a different event. Synchronize the existing capture first.',
            409,
          );
        this.run(
          'INSERT INTO local_events(id,workspace_id,repository_id,session_id,sequence,digest,payload_json,received_at) VALUES(?,?,?,?,?,?,?,?)',
          event.eventId,
          context.workspace.id,
          event.repositoryId,
          event.sessionId,
          event.sequence,
          digest,
          JSON.stringify(event),
          now(),
        );
        this.run(
          'INSERT INTO local_jobs(id,event_id,workspace_id,repository_id,session_id,workspace_generation,repository_generation,session_generation,available_at) VALUES(?,?,?,?,?,?,?,?,?)',
          event.eventId,
          event.eventId,
          context.workspace.id,
          event.repositoryId,
          event.sessionId,
          context.workspace.generation,
          integer(repository, 'generation'),
          integer(session, 'generation'),
          now(),
        );
      }
      return events.map(({ event }) => event.eventId);
    });
  }
  search(context: LocalContext, input: SearchRequest, sessionId?: string): Memory[] {
    this.requireContext(context);
    if (sessionId) this.sessionRow(context, sessionId);
    const repositoryIds = input.repositoryIds ? [...new Set(input.repositoryIds)] : undefined;
    if (repositoryIds) {
      for (const id of repositoryIds) this.repositoryRow(context, id);
      if (!repositoryIds.length) return [];
    }
    const stop = new Set([
      'how',
      'did',
      'i',
      'the',
      'a',
      'an',
      'and',
      'or',
      'to',
      'was',
      'is',
      'it',
      'what',
      'why',
      'my',
      'we',
      'fix',
      'fixed',
    ]);
    const query = input.query.trim().toLowerCase();
    if (!query) throw new DomainError('INVALID_QUERY', 'A search query is required.');
    const words = [...new Set(query.split(/\s+/).filter((word) => word && !stop.has(word)))].slice(
      0,
      12,
    );
    const terms = words.length ? words : [query];
    // Every token is a quoted literal: user text cannot add FTS operators or column selectors.
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const sql = `SELECT m.summary_json,bm25(local_memory_fts) AS rank FROM local_memory_fts JOIN local_memories m ON m.id=local_memory_fts.memory_id JOIN local_events e ON e.id=m.event_id JOIN local_sessions s ON s.id=m.session_id JOIN local_repositories r ON r.id=m.repository_id JOIN local_workspaces w ON w.id=m.workspace_id WHERE local_memory_fts MATCH ? AND m.workspace_id=? AND w.status='active' AND w.generation=? AND r.status='active' AND s.status!='deleted'${repositoryIds ? ` AND m.repository_id IN (${repositoryIds.map(() => '?').join(',')})` : ''}${sessionId ? ' AND m.session_id=?' : ''} ORDER BY rank ASC,m.created_at DESC,m.id DESC LIMIT ?`;
    return this.rows(
      sql,
      match,
      context.workspace.id,
      context.workspace.generation,
      ...(repositoryIds ?? []),
      ...(sessionId ? [sessionId] : []),
      Math.min(input.limit ?? 10, 20),
    ).map((row) => parse<Memory>(row['summary_json']));
  }
  getMemory(context: LocalContext, id: string): Memory {
    this.requireContext(context);
    const row = this.one(
      "SELECT m.summary_json FROM local_memories m JOIN local_events e ON e.id=m.event_id JOIN local_sessions s ON s.id=m.session_id JOIN local_repositories r ON r.id=m.repository_id JOIN local_workspaces w ON w.id=m.workspace_id WHERE m.id=? AND m.workspace_id=? AND r.status='active' AND s.status!='deleted' AND w.status='active' AND w.generation=?",
      id,
      context.workspace.id,
      context.workspace.generation,
    );
    if (!row) throw notFound();
    const memory = parse<Memory>(row['summary_json']);
    for (const source of memory.sources) this.getEvent(context, source.id);
    return memory;
  }
  private jobRow(context: LocalContext, id: string): Row {
    this.requireContext(context);
    const row = this.one(
      "SELECT j.*,e.received_at AS created_at FROM local_jobs j JOIN local_events e ON e.id=j.event_id JOIN local_sessions s ON s.id=j.session_id JOIN local_repositories r ON r.id=j.repository_id JOIN local_workspaces w ON w.id=j.workspace_id WHERE j.id=? AND j.workspace_id=? AND w.owner_user_id=? AND w.status='active' AND r.status='active' AND s.status!='deleted' AND w.generation=? AND j.workspace_generation=w.generation AND j.repository_generation=r.generation AND j.session_generation=s.generation",
      id,
      context.workspace.id,
      context.user.id,
      context.workspace.generation,
    );
    if (!row) throw notFound();
    return row;
  }
  private jobDto(row: Row): JobSummary {
    const status = string(row, 'status') as JobSummary['status'];
    const rawError = nullable(row, 'last_error');
    const lastError =
      rawError === 'LEASE_ATTEMPTS_EXHAUSTED'
        ? ('LEASE_ATTEMPTS_EXHAUSTED' as const)
        : rawError
          ? ('ENRICHMENT_FAILED' as const)
          : null;
    return {
      id: string(row, 'id'),
      eventId: string(row, 'event_id'),
      repositoryId: string(row, 'repository_id'),
      sessionId: string(row, 'session_id'),
      status,
      attempts: integer(row, 'attempts'),
      maxAttempts: 3,
      retryCount: integer(row, 'retry_count'),
      createdAt: string(row, 'created_at'),
      availableAt: string(row, 'available_at'),
      leaseUntil: nullable(row, 'lease_until'),
      lastError,
      canRetry: status === 'failed',
    };
  }
  jobs(context: LocalContext, query: JobsQuery = {}): JobSummary[] {
    this.requireContext(context);
    if (query.repositoryId) this.repositoryRow(context, query.repositoryId);
    if (query.sessionId) this.sessionRow(context, query.sessionId);
    const rows = this.rows(
      `SELECT j.*,e.received_at AS created_at FROM local_jobs j JOIN local_events e ON e.id=j.event_id JOIN local_sessions s ON s.id=j.session_id JOIN local_repositories r ON r.id=j.repository_id JOIN local_workspaces w ON w.id=j.workspace_id WHERE j.workspace_id=? AND w.owner_user_id=? AND w.status='active' AND r.status='active' AND s.status!='deleted' AND w.generation=? AND j.workspace_generation=w.generation AND j.repository_generation=r.generation AND j.session_generation=s.generation${query.repositoryId ? ' AND j.repository_id=?' : ''}${query.sessionId ? ' AND j.session_id=?' : ''}${query.status ? ' AND j.status=?' : ''} ORDER BY e.received_at DESC,j.id DESC LIMIT ?`,
      context.workspace.id,
      context.user.id,
      context.workspace.generation,
      ...(query.repositoryId ? [query.repositoryId] : []),
      ...(query.sessionId ? [query.sessionId] : []),
      ...(query.status ? [query.status] : []),
      Math.min(Math.max(query.limit ?? 50, 1), 100),
    );
    return rows.map((row) => this.jobDto(row));
  }
  retryJob(context: LocalContext, id: string): JobSummary {
    return this.transaction(() => {
      const row = this.jobRow(context, id);
      if (row['status'] !== 'failed')
        throw new DomainError(
          'JOB_NOT_FAILED',
          'Only a terminal failed job can be retried. Active or completed work was not reset.',
          409,
        );
      this.run(
        "UPDATE local_jobs SET status='queued',attempts=0,retry_count=retry_count+1,available_at=?,lease_until=NULL,lease_token=NULL,last_error=NULL WHERE id=? AND status='failed'",
        now(),
        id,
      );
      return this.jobDto(this.jobRow(context, id));
    });
  }
  dashboard(context: LocalContext): Dashboard {
    this.requireContext(context);
    const count = (table: string, predicate = '') =>
      integer(
        this.one(
          `SELECT count(*) AS count FROM ${table} WHERE workspace_id=?${predicate}`,
          context.workspace.id,
        ) ?? {},
        'count',
      );
    return {
      mode: 'local',
      counts: {
        repositories: count('local_repositories', " AND status='active'"),
        sessions: count('local_sessions', " AND status!='deleted'"),
        events: count('local_events'),
        memories: count('local_memories'),
        queuedJobs: count('local_jobs', " AND status IN ('queued','running')"),
        failedJobs: count('local_jobs', " AND status='failed'"),
      },
      recentSessions: this.sessions(context, undefined, 8),
    };
  }
  deleteSession(context: LocalContext, id: string): void {
    this.transaction(() => {
      this.sessionRow(context, id);
      this.run(
        "UPDATE local_sessions SET generation=generation+1,status='deleted' WHERE id=? AND workspace_id=?",
        id,
        context.workspace.id,
      );
      this.run(
        'DELETE FROM local_events WHERE session_id=? AND workspace_id=?',
        id,
        context.workspace.id,
      );
    });
  }
  deleteRepository(context: LocalContext, id: string): void {
    this.transaction(() => {
      this.repositoryRow(context, id);
      this.run(
        "UPDATE local_repositories SET generation=generation+1,status='deleted' WHERE id=? AND workspace_id=?",
        id,
        context.workspace.id,
      );
      this.run(
        "UPDATE local_sessions SET generation=generation+1,status='deleted' WHERE repository_id=? AND workspace_id=?",
        id,
        context.workspace.id,
      );
      this.run(
        'DELETE FROM local_events WHERE repository_id=? AND workspace_id=?',
        id,
        context.workspace.id,
      );
      this.run('DELETE FROM local_repository_context WHERE repository_id=?', id);
    });
  }
  deleteWorkspace(context: LocalContext): void {
    this.transaction(() => {
      this.requireContext(context);
      this.run(
        "UPDATE local_workspaces SET generation=generation+1,status='deleted' WHERE id=?",
        context.workspace.id,
      );
      this.run(
        'DELETE FROM local_repository_context WHERE repository_id IN (SELECT id FROM local_repositories WHERE workspace_id=?)',
        context.workspace.id,
      );
      this.run('DELETE FROM local_events WHERE workspace_id=?', context.workspace.id);
      this.run(
        "UPDATE local_sessions SET status='deleted',generation=generation+1 WHERE workspace_id=?",
        context.workspace.id,
      );
      this.run(
        "UPDATE local_repositories SET status='deleted',generation=generation+1 WHERE workspace_id=?",
        context.workspace.id,
      );
    });
  }
  claimJob(): EnrichmentJob | null {
    return this.transaction(() => {
      const time = now();
      this.run(
        "UPDATE local_jobs SET status='failed',last_error='LEASE_ATTEMPTS_EXHAUSTED' WHERE status='running' AND lease_until<? AND attempts>=3",
        time,
      );
      const row = this.one(
        "SELECT j.*,e.payload_json FROM local_jobs j JOIN local_events e ON e.id=j.event_id JOIN local_workspaces w ON w.id=j.workspace_id JOIN local_repositories r ON r.id=j.repository_id JOIN local_sessions s ON s.id=j.session_id WHERE j.attempts<3 AND ((j.status='queued' AND j.available_at<=?) OR (j.status='running' AND j.lease_until<?)) AND w.status='active' AND r.status='active' AND s.status!='deleted' AND w.generation=j.workspace_generation AND r.generation=j.repository_generation AND s.generation=j.session_generation ORDER BY j.available_at,j.id LIMIT 1",
        time,
        time,
      );
      if (!row) return null;
      const leaseToken = newId();
      this.run(
        "UPDATE local_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?",
        leaseToken,
        new Date(Date.now() + 120_000).toISOString(),
        string(row, 'id'),
      );
      return {
        id: string(row, 'id'),
        leaseToken,
        event: parse<CapturedEvent>(row['payload_json']),
        workspaceGeneration: integer(row, 'workspace_generation'),
        repositoryGeneration: integer(row, 'repository_generation'),
        sessionGeneration: integer(row, 'session_generation'),
        attempts: integer(row, 'attempts') + 1,
      };
    });
  }
  completeJob(job: EnrichmentJob, memory: Memory): boolean {
    return this.transaction(() => {
      const row = this.one(
        "SELECT j.id FROM local_jobs j JOIN local_workspaces w ON w.id=j.workspace_id JOIN local_repositories r ON r.id=j.repository_id JOIN local_sessions s ON s.id=j.session_id JOIN local_events e ON e.id=j.event_id WHERE j.id=? AND j.lease_token=? AND j.status='running' AND w.status='active' AND r.status='active' AND s.status!='deleted' AND w.generation=? AND r.generation=? AND s.generation=?",
        job.id,
        job.leaseToken,
        job.workspaceGeneration,
        job.repositoryGeneration,
        job.sessionGeneration,
      );
      if (!row) return false;
      if (
        memory.id !== job.event.eventId ||
        memory.repositoryId !== job.event.repositoryId ||
        memory.sessionId !== job.event.sessionId ||
        memory.sources.length !== 1 ||
        memory.sources.some(
          (source) =>
            source.id !== job.event.eventId ||
            source.repositoryId !== job.event.repositoryId ||
            source.locator !== `/v1/events/${job.event.eventId}`,
        ) ||
        !memory.steps.length ||
        memory.steps.some(
          (step) => !step.sourceIds.length || step.sourceIds.some((id) => id !== job.event.eventId),
        )
      )
        throw new DomainError(
          'INVALID_PROVENANCE',
          'Summary references evidence outside its immutable input.',
        );
      const safeMemory = JSON.parse(
        JSON.stringify(memory, (_key, item: unknown) =>
          typeof item === 'string' ? redactText(item) : item,
        ),
      ) as Memory;
      this.run(
        'INSERT INTO local_memories(id,event_id,workspace_id,repository_id,session_id,title,summary_json,searchable_text,created_at) SELECT ?,?,?,repository_id,session_id,?,?,?,? FROM local_events WHERE id=? ON CONFLICT(event_id) DO UPDATE SET title=excluded.title,summary_json=excluded.summary_json,searchable_text=excluded.searchable_text',
        safeMemory.id,
        job.event.eventId,
        string(
          this.one('SELECT workspace_id FROM local_events WHERE id=?', job.event.eventId) ?? {},
          'workspace_id',
        ),
        safeMemory.title,
        JSON.stringify(safeMemory),
        `${safeMemory.title}\n${safeMemory.summary}\n${job.event.output.map((chunk) => chunk.text).join('\n')}`,
        safeMemory.createdAt,
        job.event.eventId,
      );
      this.run(
        "UPDATE local_jobs SET status='ready',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_token=?",
        job.id,
        job.leaseToken,
      );
      return true;
    });
  }
  failJob(job: EnrichmentJob): void {
    this.transaction(() => {
      this.run(
        "UPDATE local_jobs SET status=?,available_at=?,lease_token=NULL,lease_until=NULL,last_error='ENRICHMENT_FAILED' WHERE id=? AND lease_token=? AND status='running'",
        job.attempts >= 3 ? 'failed' : 'queued',
        new Date(Date.now() + 2 ** job.attempts * 1000).toISOString(),
        job.id,
        job.leaseToken,
      );
    });
  }
  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}
