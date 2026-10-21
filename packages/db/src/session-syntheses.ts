import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { Check } from 'typebox/value';
import {
  CreateSessionSynthesisSchema,
  IdSchema,
  SessionSynthesisConfigurationSchema,
} from '@memvora/contracts';
import type {
  CreateSessionSynthesis,
  LocalContext,
  SessionSynthesisAnalysis,
  SessionSynthesisConfiguration,
  SessionSynthesisCoverage,
  SessionSynthesisHistory,
  SessionSynthesisInput,
  SessionSynthesisMetadata,
  SessionSynthesisPreview,
  SessionSynthesisRequest,
  SessionSynthesisResponse,
  SessionSynthesisSource,
} from '@memvora/contracts';
import {
  buildSessionSynthesisInput,
  DomainError,
  sessionSynthesisInputHash,
  validateSessionSynthesisAnalysis,
  validateSessionSynthesisHistory,
  validateSessionSynthesisPreview,
  validateSessionSynthesisResponse,
} from '@memvora/core';
import type { SessionHandoverEvidence, SessionSynthesisJob } from '@memvora/core';

type Row = Record<string, SQLOutputValue>;
type Access = {
  database: DatabaseSync;
  transaction<T>(action: () => T, mode?: 'read' | 'write'): T;
  requireContext(context: LocalContext): void;
  /** The caller already owns the transaction. */
  evidence(context: LocalContext, sessionId: string): SessionHandoverEvidence;
};
type Scope = {
  context: LocalContext;
  sessionId: string;
  repositoryId: string;
  workspaceGeneration: number;
  repositoryGeneration: number;
  sessionGeneration: number;
  revision: string;
};
const notFound = () =>
  new DomainError('NOT_FOUND', 'The requested resource is not available in this workspace.', 404);
const invalid = () =>
  new DomainError('INVALID_SYNTHESIS_REQUEST', 'The synthesis request is invalid.', 400);
const invalidHistory = () =>
  new DomainError('INVALID_SYNTHESIS_DATA', 'The stored synthesis history is invalid.', 500);
const changed = () =>
  new DomainError('SYNTHESIS_INPUT_CHANGED', 'The investigation changed. Preview it again.', 409);
const configurationText = (configuration: SessionSynthesisConfiguration) =>
  JSON.stringify([
    configuration.provider,
    configuration.model,
    configuration.fingerprint,
    configuration.promptVersion,
  ]);
function checkConfiguration(configuration: SessionSynthesisConfiguration | null): void {
  if (configuration !== null && !Check(SessionSynthesisConfigurationSchema, configuration))
    throw invalid();
}
function checkId(id: string): void {
  if (!Check(IdSchema, id)) throw invalid();
}
function decode<T>(value: SQLOutputValue | undefined): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    throw new DomainError('INVALID_SYNTHESIS_DATA', 'The stored synthesis is invalid.', 500);
  }
}
const number = (row: Row, key: string) => Number(row[key]);
const text = (row: Row, key: string) => String(row[key]);
const nullable = (row: Row, key: string) => (row[key] == null ? null : String(row[key]));
const joinedScope = `JOIN local_sessions s ON s.id=j.session_id AND s.workspace_id=j.workspace_id AND s.repository_id=j.repository_id
  JOIN local_repositories r ON r.id=j.repository_id AND r.workspace_id=j.workspace_id
  JOIN local_workspaces w ON w.id=j.workspace_id`;
const liveScope = `w.owner_user_id=j.user_id AND w.status='active' AND r.status='active' AND s.status!='deleted'
  AND w.generation=j.workspace_generation AND r.generation=j.repository_generation AND s.generation=j.session_generation`;

/** Persistence only: provider calls happen outside every SQLite transaction. */
export class SessionSyntheses {
  constructor(private readonly access: Access) {}

  private scope(context: LocalContext, sessionId: string): Scope {
    this.access.requireContext(context);
    const database = this.access.database;
    const row = database
      .prepare(
        `SELECT s.*,r.generation AS repository_generation,w.generation AS workspace_generation
        FROM local_sessions s JOIN local_repositories r ON r.id=s.repository_id AND r.workspace_id=s.workspace_id
        JOIN local_workspaces w ON w.id=s.workspace_id
        WHERE s.id=? AND s.workspace_id=? AND w.owner_user_id=? AND w.generation=?
        AND w.status='active' AND r.status='active' AND s.status!='deleted'`,
      )
      .get(sessionId, context.workspace.id, context.user.id, context.workspace.generation);
    if (!row) throw notFound();
    const repositoryId = text(row, 'repository_id');
    const events = database
      .prepare(
        `SELECT count(*) AS count,coalesce(max(i.id),0) AS intake
        FROM local_events e JOIN local_event_intakes i ON i.event_id=e.id
        WHERE e.workspace_id=? AND e.repository_id=? AND e.session_id=?`,
      )
      .get(context.workspace.id, repositoryId, sessionId)!;
    const notes = database
      .prepare(
        `SELECT count(*) AS count,coalesce(max(ordinal),0) AS ordinal FROM local_session_notes
        WHERE workspace_id=? AND repository_id=? AND session_id=? AND workspace_generation=?
        AND repository_generation=? AND session_generation=?`,
      )
      .get(
        context.workspace.id,
        repositoryId,
        sessionId,
        context.workspace.generation,
        number(row, 'repository_generation'),
        number(row, 'generation'),
      )!;
    const revision = JSON.stringify([
      1,
      context.user.id,
      context.workspace.id,
      context.workspace.generation,
      repositoryId,
      number(row, 'repository_generation'),
      sessionId,
      number(row, 'generation'),
      text(row, 'title'),
      text(row, 'status'),
      nullable(row, 'closed_at'),
      number(events, 'count'),
      number(events, 'intake'),
      number(notes, 'count'),
      number(notes, 'ordinal'),
    ]);
    return {
      context,
      sessionId,
      repositoryId,
      workspaceGeneration: context.workspace.generation,
      repositoryGeneration: number(row, 'repository_generation'),
      sessionGeneration: number(row, 'generation'),
      revision,
    };
  }

  private snapshot(context: LocalContext, sessionId: string) {
    const scope = this.scope(context, sessionId);
    const result = buildSessionSynthesisInput(this.access.evidence(context, sessionId));
    const inputJson = JSON.stringify(result.input);
    const inputBytes = Buffer.byteLength(inputJson, 'utf8');
    if (inputBytes > 65_536)
      throw new DomainError(
        'SYNTHESIS_INPUT_LIMIT',
        'The bounded synthesis input is too large.',
        413,
      );
    return { ...result, scope, inputJson, inputBytes };
  }

  private sameScope(row: Row, scope: Scope): boolean {
    return (
      row['workspace_id'] === scope.context.workspace.id &&
      row['user_id'] === scope.context.user.id &&
      row['session_id'] === scope.sessionId &&
      row['repository_id'] === scope.repositoryId &&
      number(row, 'workspace_generation') === scope.workspaceGeneration &&
      number(row, 'repository_generation') === scope.repositoryGeneration &&
      number(row, 'session_generation') === scope.sessionGeneration
    );
  }

  private dto(
    row: Row,
    scope: Scope,
    configuration: SessionSynthesisConfiguration | null,
  ): SessionSynthesisRequest {
    const storedConfiguration = decode<SessionSynthesisConfiguration>(row['configuration_json']);
    const input = decode<SessionSynthesisInput>(row['input_json']);
    const request: SessionSynthesisRequest = {
      id: text(row, 'id'),
      sessionId: text(row, 'session_id'),
      repositoryId: text(row, 'repository_id'),
      status: text(row, 'status') as SessionSynthesisRequest['status'],
      attempts: number(row, 'attempts'),
      createdAt: text(row, 'created_at'),
      startedAt: nullable(row, 'started_at'),
      finishedAt: nullable(row, 'finished_at'),
      inputHash: text(row, 'input_hash'),
      configuration: storedConfiguration,
      coverage: input.coverage,
      sources: decode<SessionSynthesisSource[]>(row['sources_json']),
      stale:
        !this.sameScope(row, scope) ||
        row['revision_json'] !== scope.revision ||
        configuration === null ||
        configurationText(storedConfiguration) !== configurationText(configuration),
      failureCode: nullable(row, 'failure_code') as SessionSynthesisRequest['failureCode'],
      analysis: row['analysis_json'] === null ? null : decode(row['analysis_json']),
    };
    return validateSessionSynthesisResponse(
      { sessionId: scope.sessionId, configuration, request },
      scope.sessionId,
      request.id,
    ).request!;
  }

  preview(
    context: LocalContext,
    sessionId: string,
    configuration: SessionSynthesisConfiguration | null,
  ): SessionSynthesisPreview {
    checkId(sessionId);
    checkConfiguration(configuration);
    return this.access.transaction(() => {
      const snapshot = this.snapshot(context, sessionId);
      return validateSessionSynthesisPreview(
        {
          sessionId,
          repositoryId: snapshot.scope.repositoryId,
          availability:
            configuration === null
              ? 'disabled'
              : snapshot.input.events.length < 2
                ? 'insufficient_evidence'
                : 'available',
          configuration,
          inputHash:
            configuration === null
              ? null
              : sessionSynthesisInputHash(snapshot.input, configuration, snapshot.scope.revision),
          inputBytes: snapshot.inputBytes,
          coverage: snapshot.input.coverage,
          sourceIds: snapshot.sources.map((source) => source.id),
          notices: [
            'An explicit request sends these bounded, redacted excerpts to the configured AI provider.',
            'The analysis is an inference with citations, not an independently verified explanation.',
            'Only the selected event and authored-note excerpts are included; repository files and existing summaries are excluded.',
          ],
        },
        sessionId,
      );
    }, 'read');
  }

  request(
    context: LocalContext,
    sessionId: string,
    input: CreateSessionSynthesis,
    configuration: SessionSynthesisConfiguration | null,
  ): { request: SessionSynthesisRequest; created: boolean } {
    checkId(sessionId);
    if (!Check(CreateSessionSynthesisSchema, input)) throw invalid();
    checkConfiguration(configuration);
    return this.access.transaction(() => {
      const scope = this.scope(context, sessionId);
      const database = this.access.database;
      const existing = database
        .prepare('SELECT * FROM local_session_syntheses WHERE id=?')
        .get(input.requestId);
      if (existing) {
        if (!this.sameScope(existing, scope)) throw notFound();
        if (existing['input_hash'] !== input.expectedInputHash)
          throw new DomainError(
            'IMMUTABLE_SYNTHESIS_CONFLICT',
            'The synthesis request ID already belongs to a different request.',
            409,
          );
        return { request: this.dto(existing, scope, configuration), created: false };
      }
      if (configuration === null)
        throw new DomainError(
          'SYNTHESIS_DISABLED',
          'Configure an AI provider before requesting analysis.',
          503,
        );
      const snapshot = this.snapshot(context, sessionId);
      if (snapshot.input.events.length < 2)
        throw new DomainError(
          'INSUFFICIENT_SYNTHESIS_EVIDENCE',
          'At least two captured commands are required.',
          422,
        );
      const inputHash = sessionSynthesisInputHash(snapshot.input, configuration, scope.revision);
      if (inputHash !== input.expectedInputHash) throw changed();
      if (
        database
          .prepare(
            "SELECT 1 FROM local_session_syntheses WHERE workspace_id=? AND session_id=? AND status IN ('queued','running') LIMIT 1",
          )
          .get(context.workspace.id, sessionId)
      )
        throw new DomainError(
          'SYNTHESIS_IN_PROGRESS',
          'This investigation already has an active analysis request.',
          409,
        );
      const counts = database
        .prepare(
          'SELECT count(*) AS workspace_count,coalesce(sum(session_id=?),0) AS session_count FROM local_session_syntheses WHERE workspace_id=?',
        )
        .get(sessionId, context.workspace.id)!;
      if (number(counts, 'session_count') >= 32 || number(counts, 'workspace_count') >= 512)
        throw new DomainError(
          'SYNTHESIS_QUOTA',
          'The retained analysis request limit has been reached.',
          409,
        );
      database
        .prepare(
          `INSERT INTO local_session_syntheses(id,workspace_id,user_id,repository_id,session_id,
          workspace_generation,repository_generation,session_generation,revision_json,input_hash,
          input_json,sources_json,configuration_json,configuration_fingerprint,status,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?)`,
        )
        .run(
          input.requestId,
          context.workspace.id,
          context.user.id,
          scope.repositoryId,
          sessionId,
          scope.workspaceGeneration,
          scope.repositoryGeneration,
          scope.sessionGeneration,
          scope.revision,
          inputHash,
          snapshot.inputJson,
          JSON.stringify(snapshot.sources),
          JSON.stringify(configuration),
          configuration.fingerprint,
          new Date().toISOString(),
        );
      const row = database
        .prepare('SELECT * FROM local_session_syntheses WHERE id=?')
        .get(input.requestId)!;
      return { request: this.dto(row, scope, configuration), created: true };
    });
  }

  get(
    context: LocalContext,
    sessionId: string,
    configuration: SessionSynthesisConfiguration | null,
    requestId?: string,
  ): SessionSynthesisResponse {
    checkId(sessionId);
    if (requestId !== undefined) checkId(requestId);
    checkConfiguration(configuration);
    return this.access.transaction(() => {
      const scope = this.scope(context, sessionId);
      const row =
        requestId === undefined
          ? this.access.database
              .prepare(
                'SELECT * FROM local_session_syntheses WHERE workspace_id=? AND session_id=? AND user_id=? AND workspace_generation=? AND repository_generation=? AND session_generation=? ORDER BY ordinal DESC LIMIT 1',
              )
              .get(
                context.workspace.id,
                sessionId,
                context.user.id,
                scope.workspaceGeneration,
                scope.repositoryGeneration,
                scope.sessionGeneration,
              )
          : this.access.database
              .prepare('SELECT * FROM local_session_syntheses WHERE id=?')
              .get(requestId);
      if (row && !this.sameScope(row, scope)) throw notFound();
      if (requestId !== undefined && !row) throw notFound();
      return {
        sessionId,
        configuration,
        request: row ? this.dto(row, scope, configuration) : null,
      };
    }, 'read');
  }

  /** A complete bounded metadata list; source, analysis and full input text never cross into JS. */
  history(
    context: LocalContext,
    sessionId: string,
    configuration: SessionSynthesisConfiguration | null,
  ): SessionSynthesisHistory {
    checkId(sessionId);
    checkConfiguration(configuration);
    return this.access.transaction(() => {
      const scope = this.scope(context, sessionId);
      let rows: Row[];
      try {
        rows = this.access.database
          .prepare(
            `SELECT id,workspace_id,user_id,repository_id,session_id,
              workspace_generation,repository_generation,session_generation,
              CASE WHEN length(CAST(revision_json AS BLOB))<=16384 THEN revision_json ELSE NULL END AS revision_json,
              input_hash,
              CASE WHEN length(CAST(configuration_json AS BLOB))<=4096 THEN configuration_json ELSE NULL END AS configuration_json,
              status,attempts,created_at,started_at,finished_at,failure_code,
              json_extract(CASE WHEN length(CAST(input_json AS BLOB))<=65536 THEN input_json ELSE NULL END,'$.coverage') AS coverage_json
            FROM local_session_syntheses
            WHERE workspace_id=? AND session_id=? AND user_id=? AND repository_id=?
              AND workspace_generation=? AND repository_generation=? AND session_generation=?
            ORDER BY ordinal DESC LIMIT 33`,
          )
          .all(
            context.workspace.id,
            sessionId,
            context.user.id,
            scope.repositoryId,
            scope.workspaceGeneration,
            scope.repositoryGeneration,
            scope.sessionGeneration,
          );
      } catch {
        // SQLite JSON diagnostics must never expose stored evidence to a caller.
        throw invalidHistory();
      }
      if (rows.length > 32) throw invalidHistory();
      const items: SessionSynthesisMetadata[] = rows.map((row) => {
        if (!this.sameScope(row, scope) || typeof row['revision_json'] !== 'string')
          throw invalidHistory();
        const storedConfiguration = decode<SessionSynthesisConfiguration>(
          row['configuration_json'],
        );
        if (!Check(SessionSynthesisConfigurationSchema, storedConfiguration))
          throw invalidHistory();
        return {
          id: text(row, 'id'),
          sessionId: text(row, 'session_id'),
          repositoryId: text(row, 'repository_id'),
          status: text(row, 'status') as SessionSynthesisMetadata['status'],
          attempts: number(row, 'attempts'),
          createdAt: text(row, 'created_at'),
          startedAt: nullable(row, 'started_at'),
          finishedAt: nullable(row, 'finished_at'),
          inputHash: text(row, 'input_hash'),
          configuration: storedConfiguration,
          coverage: decode<SessionSynthesisCoverage>(row['coverage_json']),
          stale:
            row['revision_json'] !== scope.revision ||
            configuration === null ||
            configurationText(storedConfiguration) !== configurationText(configuration),
          failureCode: nullable(row, 'failure_code') as SessionSynthesisMetadata['failureCode'],
        };
      });
      return validateSessionSynthesisHistory(
        {
          sessionId,
          repositoryId: scope.repositoryId,
          configuration,
          items,
          retainedCount: items.length,
          requestLimit: 32,
          order: 'newest_requested_first',
          analysisIncluded: false,
          sourcesIncluded: false,
        },
        sessionId,
      );
    }, 'read');
  }

  private scopeForRow(row: Row): Scope | null {
    const live = this.access.database
      .prepare(
        `SELECT w.name AS workspace_name,i.display_name FROM local_session_syntheses j ${joinedScope}
        JOIN local_identity i ON i.user_id=j.user_id AND i.singleton=1 WHERE j.id=? AND ${liveScope}`,
      )
      .get(text(row, 'id'));
    if (!live) return null;
    return this.scope(
      {
        mode: 'local',
        user: { id: text(row, 'user_id'), name: text(live, 'display_name') },
        workspace: {
          id: text(row, 'workspace_id'),
          name: text(live, 'workspace_name'),
          generation: number(row, 'workspace_generation'),
        },
      },
      text(row, 'session_id'),
    );
  }

  private finish(
    row: Row,
    status: 'failed' | 'superseded',
    code: NonNullable<SessionSynthesisRequest['failureCode']>,
  ): void {
    this.access.database
      .prepare(
        'UPDATE local_session_syntheses SET status=?,failure_code=?,finished_at=?,lease_token=NULL,lease_until=NULL WHERE id=?',
      )
      .run(status, code, new Date().toISOString(), text(row, 'id'));
  }

  claim(configuration: SessionSynthesisConfiguration | null): SessionSynthesisJob | null {
    checkConfiguration(configuration);
    return this.access.transaction(() => {
      const database = this.access.database;
      const time = new Date().toISOString();
      database
        .prepare(
          "UPDATE local_session_syntheses SET status='failed',failure_code='INTERRUPTED',finished_at=?,lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?",
        )
        .run(time, time);
      database
        .prepare(
          `UPDATE local_session_syntheses SET status='superseded',failure_code='INPUT_CHANGED',finished_at=?,lease_token=NULL,lease_until=NULL
        WHERE status IN ('queued','running') AND id NOT IN(SELECT j.id FROM local_session_syntheses j ${joinedScope} WHERE ${liveScope})`,
        )
        .run(time);
      if (configuration === null) {
        database
          .prepare(
            "UPDATE local_session_syntheses SET status='superseded',failure_code='CONFIGURATION_CHANGED',finished_at=?,lease_token=NULL,lease_until=NULL WHERE status IN ('queued','running')",
          )
          .run(time);
        return null;
      }
      // Compare full non-secret descriptors as well as the configuration fingerprint.
      database
        .prepare(
          "UPDATE local_session_syntheses SET status='superseded',failure_code='CONFIGURATION_CHANGED',finished_at=?,lease_token=NULL,lease_until=NULL WHERE status IN ('queued','running') AND (configuration_fingerprint!=? OR json_extract(configuration_json,'$.provider')!=? OR json_extract(configuration_json,'$.model')!=? OR json_extract(configuration_json,'$.promptVersion')!=?)",
        )
        .run(
          time,
          configuration.fingerprint,
          configuration.provider,
          configuration.model,
          configuration.promptVersion,
        );
      // A bounded maintenance pass prevents an old stale queue from monopolizing a worker turn.
      for (let inspected = 0; inspected < 32; inspected++) {
        const row = database
          .prepare(
            "SELECT * FROM local_session_syntheses WHERE status='queued' AND attempts=0 ORDER BY ordinal ASC LIMIT 1",
          )
          .get();
        if (!row) return null;
        const scope = this.scopeForRow(row);
        if (!scope || row['revision_json'] !== scope.revision) {
          this.finish(row, 'superseded', 'INPUT_CHANGED');
          continue;
        }
        const leaseToken = randomUUID();
        database
          .prepare(
            "UPDATE local_session_syntheses SET status='running',attempts=1,started_at=?,lease_token=?,lease_until=? WHERE id=? AND status='queued' AND attempts=0",
          )
          .run(time, leaseToken, new Date(Date.now() + 120_000).toISOString(), text(row, 'id'));
        return {
          id: text(row, 'id'),
          leaseToken,
          input: decode<SessionSynthesisInput>(row['input_json']),
          inputHash: text(row, 'input_hash'),
          configuration: decode<SessionSynthesisConfiguration>(row['configuration_json']),
        };
      }
      return null;
    });
  }

  private leased(job: SessionSynthesisJob): Row | null {
    const row = this.access.database
      .prepare(
        "SELECT * FROM local_session_syntheses WHERE id=? AND lease_token=? AND status='running' AND attempts=1",
      )
      .get(job.id, job.leaseToken);
    if (!row) return null;
    const configuration = decode<SessionSynthesisConfiguration>(row['configuration_json']);
    if (
      row['input_hash'] !== job.inputHash ||
      configurationText(configuration) !== configurationText(job.configuration)
    )
      return null;
    if (text(row, 'lease_until') <= new Date().toISOString()) {
      this.finish(row, 'failed', 'INTERRUPTED');
      return null;
    }
    const scope = this.scopeForRow(row);
    if (!scope || row['revision_json'] !== scope.revision) {
      this.finish(row, 'superseded', 'INPUT_CHANGED');
      return null;
    }
    return row;
  }

  complete(job: SessionSynthesisJob, analysis: SessionSynthesisAnalysis): boolean {
    return this.access.transaction(() => {
      const row = this.leased(job);
      if (!row) return false;
      const validated = validateSessionSynthesisAnalysis(
        analysis,
        decode<SessionSynthesisInput>(row['input_json']),
      );
      const resultJson = JSON.stringify(validated);
      if (Buffer.byteLength(resultJson, 'utf8') > 131_072)
        throw new DomainError(
          'INVALID_SYNTHESIS_ANALYSIS',
          'The analysis response exceeds its limit.',
          502,
        );
      this.access.database
        .prepare(
          "UPDATE local_session_syntheses SET status='ready',analysis_json=?,finished_at=?,failure_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='running'",
        )
        .run(resultJson, new Date().toISOString(), job.id, job.leaseToken);
      return true;
    });
  }

  fail(job: SessionSynthesisJob): void {
    this.access.transaction(() => {
      const row = this.leased(job);
      if (row) this.finish(row, 'failed', 'PROVIDER_FAILED');
    });
  }
}
