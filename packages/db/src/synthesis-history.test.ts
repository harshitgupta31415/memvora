import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CapturedEvent,
  LocalContext,
  SessionSynthesisConfiguration,
} from '@memvora/contracts';
import { DomainError, prepareEvents } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const configuration: SessionSynthesisConfiguration = {
  provider: 'synthetic-history-provider',
  model: 'synthetic-history-model',
  fingerprint: 'c'.repeat(64),
  promptVersion: 'session-analysis-v1',
};
const stores: SqliteEvidenceStore[] = [];
const folders: string[] = [];
const temporaryRoot = realpathSync(tmpdir());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (!existsSync(folder)) continue;
    const target = realpathSync(resolve(folder));
    if (
      dirname(target) !== temporaryRoot ||
      !target.startsWith(join(temporaryRoot, 'memvora-synthesis-history-')) ||
      !basename(target).startsWith('memvora-synthesis-history-')
    )
      throw new Error('Unsafe history fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
function open(path = ':memory:') {
  const store = new SqliteEvidenceStore(path);
  stores.push(store);
  return store;
}
function database(store: SqliteEvidenceStore) {
  return (store as unknown as { database: DatabaseSync }).database;
}
function fixture(path = ':memory:') {
  const store = open(path);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Synthetic synthesis history' });
  const session = store.createSession(context, { repositoryId: repository.id });
  const event = (sequence: number): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'synthetic-observation', args: [], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: sequence === 1 ? 1 : 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stdout', ordinal: 0, text: 'PRIVATE_HISTORY_INPUT_NOT_IN_METADATA' }],
    diffs: [],
  });
  store.ingest(context, prepareEvents([event(1), event(2)]));
  const request = () =>
    store.requestSessionSynthesis(
      context,
      session.id,
      {
        requestId: randomUUID(),
        expectedInputHash: store.getSessionSynthesisPreview(context, session.id, configuration)
          .inputHash!,
      },
      configuration,
    ).request;
  const fail = () => {
    const result = request();
    const job = store.claimSessionSynthesis(configuration)!;
    store.failSessionSynthesis(job);
    return result.id;
  };
  const history = (config: SessionSynthesisConfiguration | null = configuration) =>
    store.listSessionSyntheses(context, session.id, config);
  return { store, context, repository, session, event, request, fail, history };
}
function unchanged(store: SqliteEvidenceStore, action: () => unknown) {
  const db = database(store);
  const before = db.prepare('SELECT total_changes() AS count').get()!['count'];
  action();
  expect(db.prepare('SELECT total_changes() AS count').get()!['count']).toBe(before);
}
function rejected(action: () => unknown, code: string) {
  try {
    action();
    throw new Error('Expected the history read to be rejected.');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('PRIVATE_HISTORY');
  }
}

describe('read-only synthesis version discovery', () => {
  it('returns an empty complete history without requiring enough commands or an enabled provider', () => {
    const f = fixture();
    const empty = f.store.createSession(f.context, { repositoryId: f.repository.id });
    unchanged(f.store, () => {
      expect(f.store.listSessionSyntheses(f.context, empty.id, null)).toEqual({
        sessionId: empty.id,
        repositoryId: f.repository.id,
        configuration: null,
        items: [],
        retainedCount: 0,
        requestLimit: 32,
        order: 'newest_requested_first',
        analysisIncluded: false,
        sourcesIncluded: false,
      });
    });
  });

  it('discovers all 32 versions in reverse append order despite identical timestamps and a newer failure', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));
    const f = fixture();
    const ids: string[] = [];
    const first = f.request();
    ids.push(first.id);
    const job = f.store.claimSessionSynthesis(configuration)!;
    const analysis = {
      overview: { text: 'PRIVATE_HISTORY_ANALYSIS_TEXT', sourceIds: [job.input.events[0]!.id] },
      hypotheses: [],
      unresolvedQuestions: [],
      suggestedChecks: [],
      uncertainty: ['Synthetic evidence is limited.'],
    };
    expect(f.store.completeSessionSynthesis(job, analysis)).toBe(true);
    for (let index = 1; index < 32; index++) ids.push(f.fail());
    unchanged(f.store, () => {
      const history = f.history();
      expect(history.retainedCount).toBe(32);
      expect(history.items.map((item) => item.id)).toEqual([...ids].reverse());
      expect(new Set(history.items.map((item) => item.createdAt)).size).toBe(1);
      expect(history.items[0]).toMatchObject({ status: 'failed', failureCode: 'PROVIDER_FAILED' });
      expect(history.items.at(-1)).toMatchObject({ id: first.id, status: 'ready', stale: false });
      expect(history.analysisIncluded).toBe(false);
      expect(history.sourcesIncluded).toBe(false);
      expect(JSON.stringify(history)).not.toContain('PRIVATE_HISTORY');
      expect(
        history.items.every(
          (item) => !('analysis' in item) && !('sources' in item) && !('input' in item),
        ),
      ).toBe(true);
      expect(
        f.store.getSessionSynthesis(
          f.context,
          f.session.id,
          configuration,
          history.items.at(-1)!.id,
        ).request!.analysis,
      ).toEqual(analysis);
    });
  });

  it('reads metadata without selecting/parsing analysis, sources or full provider input', () => {
    const f = fixture();
    const id = f.fail();
    // These excluded fields deliberately cannot be decoded as result/source DTOs.
    database(f.store)
      .prepare('UPDATE local_session_syntheses SET sources_json=?,analysis_json=? WHERE id=?')
      .run('PRIVATE_HISTORY_SOURCE_NOT_JSON', 'PRIVATE_HISTORY_RESULT_NOT_JSON', id);
    const db = database(f.store);
    const prepare = db.prepare.bind(db);
    const queries: string[] = [];
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      queries.push(sql);
      return prepare(sql);
    });
    const history = f.history();
    spy.mockRestore();
    expect(history.items.map((item) => item.id)).toEqual([id]);
    expect(JSON.stringify(history)).not.toContain('PRIVATE_HISTORY');
    const reads = queries.filter((sql) => /FROM\s+local_session_syntheses\b/iu.test(sql));
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toMatch(/\b(?:analysis_json|sources_json)\b|SELECT\s+\*/iu);
    expect(reads[0]).not.toMatch(/(?:SELECT|,)\s*input_json\s*(?:,|FROM)/iu);
    expect(reads[0]).toMatch(/json_extract\(/iu);
  });

  it('shows queued/running states and computes changed-input and disabled/configuration staleness without maintenance', () => {
    const f = fixture();
    const id = f.request().id;
    unchanged(f.store, () =>
      expect(f.history().items[0]).toMatchObject({ id, status: 'queued', stale: false }),
    );
    f.store.claimSessionSynthesis(configuration);
    unchanged(f.store, () => {
      expect(f.history(null)).toMatchObject({
        configuration: null,
        items: [{ id, status: 'running', stale: true }],
      });
      expect(
        f.history({ ...configuration, model: 'different-model-same-fingerprint' }).items[0]!.stale,
      ).toBe(true);
    });
    f.store.createSessionNote(f.context, f.session.id, {
      id: randomUUID(),
      kind: 'note',
      body: 'A new author claim.',
      eventIds: [],
    });
    unchanged(f.store, () =>
      expect(f.history().items[0]).toMatchObject({ status: 'running', stale: true }),
    );
    expect(
      database(f.store).prepare('SELECT status FROM local_session_syntheses WHERE id=?').get(id)![
        'status'
      ],
    ).toBe('running');
  });

  it('keeps session/user selection and current generations fenced', () => {
    const f = fixture();
    f.fail();
    const other = f.store.createSession(f.context, { repositoryId: f.repository.id });
    expect(f.store.listSessionSyntheses(f.context, other.id, configuration).items).toEqual([]);
    const foreign: LocalContext = {
      ...f.context,
      user: { id: randomUUID(), name: 'Other principal' },
    };
    rejected(
      () => f.store.listSessionSyntheses(foreign, f.session.id, configuration),
      'WORKSPACE_UNAVAILABLE',
    );
    rejected(
      () => f.store.listSessionSyntheses(f.context, randomUUID(), configuration),
      'NOT_FOUND',
    );
    for (const table of ['local_sessions', 'local_repositories', 'local_workspaces']) {
      const g = fixture();
      g.fail();
      const id =
        table === 'local_sessions'
          ? g.session.id
          : table === 'local_repositories'
            ? g.repository.id
            : g.context.workspace.id;
      database(g.store).prepare(`UPDATE ${table} SET generation=generation+1 WHERE id=?`).run(id);
      const context = table === 'local_workspaces' ? g.store.context() : g.context;
      expect(g.store.listSessionSyntheses(context, g.session.id, configuration).items).toEqual([]);
      if (table === 'local_workspaces') rejected(() => g.history(), 'WORKSPACE_UNAVAILABLE');
    }
  });

  it.each(['session', 'repository', 'workspace'] as const)(
    'denies history after %s deletion without rewriting tombstones',
    (scope) => {
      const f = fixture();
      f.fail();
      if (scope === 'session') f.store.deleteSession(f.context, f.session.id);
      else if (scope === 'repository') f.store.deleteRepository(f.context, f.repository.id);
      else f.store.deleteWorkspace(f.context);
      unchanged(f.store, () =>
        rejected(() => f.history(), scope === 'workspace' ? 'WORKSPACE_UNAVAILABLE' : 'NOT_FOUND'),
      );
    },
  );

  it('fails closed on malformed/oversized metadata and impossible lifecycle state without leaking stored text', () => {
    for (const mutation of [
      "UPDATE local_session_syntheses SET input_json=json_set(input_json,'$.coverage.includedEvents',99)",
      "UPDATE local_session_syntheses SET input_json='PRIVATE_HISTORY_INVALID_JSON'",
      "UPDATE local_session_syntheses SET status='ready',attempts=0,started_at=NULL,failure_code=NULL",
      "UPDATE local_session_syntheses SET configuration_json='PRIVATE_HISTORY_' || printf('%05000d',0)",
    ]) {
      const f = fixture();
      f.fail();
      database(f.store).exec(mutation);
      unchanged(f.store, () => {
        try {
          f.history();
          throw new Error('Expected corrupt metadata to fail closed.');
        } catch (error) {
          expect(error).toBeInstanceOf(DomainError);
          expect(String(error)).not.toContain('PRIVATE_HISTORY');
        }
      });
    }
  });

  it('rejects an impossible 33rd retained version instead of silently dropping history', () => {
    const f = fixture();
    for (let index = 0; index < 32; index++) f.fail();
    const columns = [
      'workspace_id',
      'user_id',
      'repository_id',
      'session_id',
      'workspace_generation',
      'repository_generation',
      'session_generation',
      'revision_json',
      'input_hash',
      'input_json',
      'sources_json',
      'configuration_json',
      'configuration_fingerprint',
      'status',
      'attempts',
      'created_at',
      'started_at',
      'finished_at',
      'failure_code',
    ].join(',');
    database(f.store)
      .prepare(
        `INSERT INTO local_session_syntheses(id,${columns}) SELECT ?,${columns} FROM local_session_syntheses ORDER BY ordinal ASC LIMIT 1`,
      )
      .run(randomUUID());
    unchanged(f.store, () => rejected(() => f.history(), 'INVALID_SYNTHESIS_DATA'));
  });

  it('retains complete metadata order across restart with no schema migration or read writes', () => {
    const directory = mkdtempSync(join(temporaryRoot, 'memvora-synthesis-history-'));
    folders.push(directory);
    const path = join(directory, 'server.sqlite');
    const f = fixture(path);
    f.fail();
    f.fail();
    f.request();
    const before = f.history();
    const version = database(f.store).prepare('PRAGMA user_version').get()!['user_version'];
    f.store.close();
    const reopened = open(path);
    expect(database(reopened).prepare('PRAGMA user_version').get()!['user_version']).toBe(version);
    unchanged(reopened, () =>
      expect(reopened.listSessionSyntheses(f.context, f.session.id, configuration)).toEqual(before),
    );
  });
});
