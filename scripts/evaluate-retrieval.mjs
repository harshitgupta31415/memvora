import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Check } from 'typebox/value';
import {
  MemoryResponseSchema,
  MemorySchema,
  RecallAnswerSchema,
  RepositorySourceSearchResponseSchema,
  SearchResponseSchema,
  SessionNoteSearchResponseSchema,
} from '../packages/contracts/dist/index.js';
import { deriveObservedMemory, prepareEvents } from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import {
  cases,
  corpusVersion,
  eventsFor,
  ids,
  journal,
  sessions,
  sourceText,
} from './fixtures/recall-evaluation.mjs';

const arguments_ = process.argv.slice(2);
assert.ok(
  arguments_.every((value) => value === '--baseline') && arguments_.length <= 1,
  'Use only optional --baseline.',
);
const baseline = arguments_.includes('--baseline');
const root = resolve(import.meta.dirname, '..');
const implementationFiles = [
  'packages/db/dist/sqlite-store.js',
  'packages/core/dist/local-service.js',
];
const compiledSha256 = () =>
  Object.fromEntries(
    implementationFiles.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    ]),
  );
const implementationSha256 = compiledSha256();
const corpusSha256 = createHash('sha256')
  .update(readFileSync(new URL('./fixtures/recall-evaluation.mjs', import.meta.url)))
  .digest('hex');
const baselineAllowedFailures = Object.fromEntries(
  cases.map((entry) => [entry.id, entry.baselineAllowed]),
);
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-retrieval-evaluation-'));
const token = randomBytes(32).toString('hex');
const foreignMarker = 'ForeignEvaluationEvidenceMustNotBeReturned';
const store = new SqliteEvidenceStore(':memory:');
let providerCalls = 0;
const app = buildApp({
  store,
  token,
  embeddedWorker: false,
  enricher: async () => {
    providerCalls++;
    throw new Error('Evaluation must not call enrichment.');
  },
});
const repositories = {};
const sessionRecords = {};
const eventRecords = new Map();
const aliases = { ...ids };
const processes = new Map();
const qualityFailures = [];
const results = [];
const answers = new Map();
let origin;
let stage = 'fixture setup';
let report;
let mcp;
let savedNote;
let savedSource;
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  const upper = name.toUpperCase();
  if (
    upper.startsWith('MEMVORA_') ||
    upper.startsWith('GITHUB_') ||
    upper.startsWith('GH_') ||
    upper.startsWith('AI_') ||
    upper.startsWith('DOTENV_') ||
    upper === 'NODE_PATH' ||
    upper === 'NODE_OPTIONS'
  )
    delete environment[name];
}
Object.assign(environment, {
  MEMVORA_DATA_DIR: fixture,
  NODE_OPTIONS: '--max-old-space-size=1536 --v8-pool-size=1',
  UV_THREADPOOL_SIZE: '2',
});
writeFileSync(join(fixture, 'local-token'), `${token}\n`, { mode: 0o600 });
writeFileSync(join(fixture, '.git'), 'gitdir: synthetic-evaluation-boundary-not-used\n');

function safe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(
    !text.includes(token) && !text.includes(foreignMarker),
    'Evaluation exposed private fixture data.',
  );
}
function quality(condition, caseId, reason) {
  if (!condition) {
    const failureClass = reason.split(':')[0];
    qualityFailures.push({
      caseId,
      reason,
      failureClass,
      baselineAllowed: baselineAllowedFailures[caseId]?.includes(failureClass) === true,
    });
  }
}
async function http(path, body, { expected = 200, schema, credential = token } = {}) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, 'Evaluation API status violated its contract.');
  const value = await response.json();
  safe(value);
  if (schema) assert.ok(Check(schema, value), 'Evaluation API response violated its schema.');
  return value;
}
function metrics(returned, relevant, k) {
  const top = returned.slice(0, k);
  const hits = top.filter((id) => relevant.includes(id)).length;
  const rank = top.findIndex((id) => relevant.includes(id));
  return {
    k,
    returned: top.length,
    returnedIds: top,
    hits,
    precisionAtK: hits / k,
    recallAtK: relevant.length ? hits / relevant.length : null,
    hitAtK: relevant.length ? Number(hits > 0) : null,
    reciprocalRankAtK: relevant.length ? (rank < 0 ? 0 : 1 / (rank + 1)) : null,
  };
}
function summarize(rows) {
  const positive = rows.filter((row) => row.expectedRelevantIds.length);
  const negative = rows.filter((row) => !row.expectedRelevantIds.length);
  return {
    cases: rows.length,
    positiveCases: positive.length,
    negativeCases: negative.length,
    correctEmptyResults: negative.filter((row) => row.returnedIds.length === 0).length,
    atK: [1, 3, 5].map((k) => ({
      k,
      ...Object.fromEntries(
        ['precisionAtK', 'recallAtK', 'hitAtK', 'reciprocalRankAtK'].map((key) => [
          key,
          positive.length
            ? positive.reduce(
                (sum, row) => sum + row.metrics.find((item) => item.k === k)[key],
                0,
              ) / positive.length
            : null,
        ]),
      ),
    })),
  };
}
function scope(itemRepository, selected) {
  assert.ok(
    Object.values(repositories).some((repository) => repository.id === itemRepository),
    'Retrieval returned an unauthorized repository.',
  );
  if (selected !== undefined)
    assert.ok(
      selected.includes(itemRepository),
      'Retrieval widened an explicit repository filter.',
    );
}
function memoryIntegrity(memory, selected) {
  assert.ok(Check(MemorySchema, memory), 'Retrieved memory violated its runtime contract.');
  const original = eventRecords.get(memory.id);
  assert.ok(original, 'Retrieval returned an unknown/foreign event.');
  scope(memory.repositoryId, selected);
  assert.equal(memory.sessionId, original.sessionId);
  assert.equal(memory.repositoryId, original.repositoryId);
  assert.deepEqual(
    memory.sources.map((source) => source.id),
    [memory.id],
  );
  assert.ok(
    memory.sources.every(
      (source) =>
        source.kind === 'event' &&
        source.repositoryId === memory.repositoryId &&
        source.locator === `/v1/events/${memory.id}`,
    ),
  );
  assert.ok(memory.steps.every((step) => step.sourceIds.every((id) => id === memory.id)));
}
function answerIntegrity(answer, selected, sessionId) {
  const sourceIds = new Set(answer.sources.map((source) => source.id));
  assert.equal(sourceIds.size, answer.sources.length, 'Ask repeated source identities.');
  assert.ok(
    answer.steps.every((step) => step.sourceIds.every((id) => sourceIds.has(id))),
    'Ask has unresolved step citations.',
  );
  for (const source of answer.sources) {
    scope(source.repositoryId, selected);
    if (source.kind === 'event') {
      const event = eventRecords.get(source.id);
      assert.ok(event, 'Ask exposed an unknown/foreign event.');
      assert.equal(event.repositoryId, source.repositoryId);
      if (sessionId) assert.equal(event.sessionId, sessionId, 'Ask crossed a selected session.');
      assert.equal(source.locator, `/v1/events/${source.id}`);
    } else if (source.kind === 'session_note') {
      assert.deepEqual(
        source,
        {
          id: savedNote.id,
          kind: 'session_note',
          repositoryId: savedNote.repositoryId,
          sessionId: savedNote.sessionId,
          locator: `/v1/session-notes/${savedNote.id}`,
          authorName: savedNote.author.name,
          createdAt: savedNote.createdAt,
          noteKind: savedNote.kind,
        },
        'Ask changed the original authored-note provenance.',
      );
      assert.ok(
        savedNote.sources.every((attached) => sourceIds.has(attached.id)),
        'Ask dropped an original event attached to its cited note.',
      );
      if (sessionId) assert.equal(source.sessionId, sessionId);
    } else {
      const canonical = savedSource.source;
      assert.deepEqual(
        source,
        {
          id: canonical.id,
          kind: 'repository_file',
          repositoryId: canonical.repositoryId,
          locator: `/v1/repository-sources/${canonical.id}?startLine=${savedSource.startLine}&limit=${savedSource.endLine - savedSource.startLine + 1}`,
          fullName: canonical.fullName,
          path: canonical.path,
          commitSha: canonical.commitSha,
          contentHash: canonical.contentHash,
          startLine: savedSource.startLine,
          endLine: savedSource.endLine,
        },
        'Ask changed the original imported-file provenance.',
      );
    }
  }
  if (selected?.length === 0) {
    assert.equal(answer.sources.length, 0, 'Empty scope exposed evidence.');
    assert.equal(answer.status, 'insufficient_evidence');
  }
  assert.ok(answer.steps.length <= 30, 'Ask exceeded its step budget.');
}
async function waitClosed(state, milliseconds) {
  if (state.closed) return true;
  let timer;
  try {
    return await Promise.race([
      state.done.then(() => true),
      new Promise((done) => {
        timer = setTimeout(() => done(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(child) {
  const state = processes.get(child);
  if (!state) throw new Error('Refusing cleanup of an unowned evaluation process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitClosed(state, 1000)) return;
      throw new Error('Evaluation process cleanup could not be confirmed.');
    }
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((done) =>
          execFile(
            join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 },
            () => done(),
          ),
        );
    } else {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (state.closed) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== 'ESRCH') throw new Error('Evaluation process group cleanup failed.');
        }
        if (signal === 'SIGTERM' && (await waitClosed(state, 1000))) return;
      }
    }
    if (!(await waitClosed(state, 3000))) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw new Error('Evaluation process cleanup could not be confirmed.');
    }
  })();
  return state.stopping;
}
function start(args, interactive = false) {
  const child = spawn(process.execPath, args, {
    cwd: fixture,
    env: environment,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const state = { closed: false, bytes: 0, stdout: '', stderr: '', failed: false };
  state.done = new Promise((done) =>
    child.once('close', (code, signal) => {
      state.closed = true;
      done({ code, signal });
    }),
  );
  child.on('error', () => {
    state.failed = true;
  });
  for (const channel of ['stdout', 'stderr']) {
    const decoder = new StringDecoder('utf8');
    child[channel].on('data', (chunk) => {
      state.bytes += chunk.length;
      if (state.bytes > 2 * 1024 * 1024) {
        state.failed = true;
        void stop(child).catch(() => {});
        return;
      }
      state[channel] += decoder.write(chunk);
    });
    child[channel].once('end', () => {
      state[channel] += decoder.end();
    });
  }
  processes.set(child, state);
  return child;
}
async function cli(input) {
  const child = start([
    join(root, 'apps/cli/dist/index.js'),
    'ask',
    input.query,
    '--repository',
    repositories[input.repositories[0]].id,
  ]);
  const state = processes.get(child);
  let timer;
  try {
    const result = await Promise.race([
      state.done,
      new Promise((_done, reject) => {
        timer = setTimeout(() => {
          void stop(child)
            .finally(() => reject(new Error('Evaluation CLI timed out.')))
            .catch(() => {});
        }, 15_000);
      }),
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(state.failed, false);
    safe(state.stdout);
    safe(state.stderr);
    return state.stdout;
  } finally {
    clearTimeout(timer);
    if (state.stopping) await state.stopping;
  }
}
function startMcp() {
  const child = start([join(root, 'apps/mcp/dist/index.js')], true);
  const waiting = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let nextId = 0;
  let failure;
  const fail = (error) => {
    failure ??= error;
    for (const waiter of waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiting.clear();
  };
  child.on('error', () => fail(new Error('Evaluation MCP startup failed.')));
  child.once('close', () => {
    if (waiting.size) fail(new Error('Evaluation MCP closed before responding.'));
  });
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > 256 * 1024)
      return fail(new Error('Evaluation MCP frame exceeded its budget.'));
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        safe(line);
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0');
        const waiter = waiting.get(message.id);
        if (waiter) {
          waiting.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error('Evaluation MCP protocol error.'));
          else waiter.resolve(message.result);
        }
      } catch {
        fail(new Error('Evaluation MCP stdout was not safe protocol JSON.'));
      }
    }
  });
  function call(method, params) {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('Evaluation MCP timed out.'));
      }, 10_000);
      waiting.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return {
    async initialize() {
      await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'memvora-retrieval-evaluation', version: '1.0.0' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      const tools = (await call('tools/list', {})).tools;
      for (const name of ['search_memory', 'get_memory', 'get_session_context'])
        assert.ok(tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint));
    },
    async tool(name, input, errorExpected = false) {
      const result = await call('tools/call', { name, arguments: input });
      safe(result);
      assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 128 * 1024);
      if (errorExpected) {
        assert.equal(result.isError, true);
        return;
      }
      assert.ok(!result.isError, 'Evaluation MCP returned an unexpected tool error.');
      return JSON.parse(result.content[0].text);
    },
    async close() {
      child.stdin.end();
      assert.ok(
        await waitClosed(processes.get(child), 5000),
        'Evaluation MCP did not exit on EOF.',
      );
      const state = processes.get(child);
      assert.equal(child.exitCode, 0);
      assert.equal(state.failed, false);
      buffer += decoder.end();
      assert.equal(buffer.trim(), '');
      safe(state.stdout);
      safe(state.stderr);
      if (failure) throw failure;
    },
  };
}

try {
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  environment.MEMVORA_API_URL = origin;
  for (const key of ['alpha', 'beta'])
    repositories[key] = (
      await http('/v1/repositories', { name: `Synthetic evaluation ${key}` }, { expected: 201 })
    ).repository;
  for (const definition of sessions) {
    const session = (
      await http(
        '/v1/sessions',
        {
          repositoryId: repositories[definition.repository].id,
          title: `Synthetic evaluation ${definition.key}`,
        },
        { expected: 201 },
      )
    ).session;
    sessionRecords[definition.key] = session;
    const events = eventsFor(definition, session.repositoryId, session.id);
    for (const event of events) eventRecords.set(event.eventId, event);
    for (let offset = 0; offset < events.length; offset += 50) {
      const batch = events.slice(offset, offset + 50);
      assert.deepEqual(
        (await http('/v1/events/batch', { schemaVersion: 1, events: batch })).acknowledgedEventIds,
        batch.map((event) => event.eventId),
      );
    }
  }
  const context = store.context();
  store.database.prepare('UPDATE local_jobs SET available_at=?').run('2099-01-01T00:00:00.000Z');
  store.database
    .prepare('UPDATE local_jobs SET available_at=? WHERE event_id=?')
    .run('2000-01-01T00:00:00.000Z', ids.stored);
  const job = store.claimJob();
  assert.equal(job.event.eventId, ids.stored);
  const summary = {
    ...deriveObservedMemory(job.event),
    title: 'Synthetic stored observation',
    summary: 'LeaseRehydrationSummary: bounded fixture summary, not a live model answer.',
    steps: [
      {
        text: 'Synthetic stored observation; open original captured event.',
        sourceIds: [ids.stored],
      },
    ],
  };
  assert.equal(store.completeJob(job, summary), true);
  store.database
    .prepare("UPDATE local_jobs SET available_at=? WHERE status='queued'")
    .run('2000-01-01T00:00:00.000Z');
  savedNote = (
    await http(`/v1/sessions/${sessionRecords.current.id}/notes`, journal, { expected: 201 })
  ).note;
  assert.deepEqual(savedNote.author, context.user);
  assert.deepEqual(
    savedNote.sources.map((source) => source.id),
    journal.eventIds,
  );
  store.saveRepositoryContext(context, repositories.alpha.id, {
    provider: 'github',
    fullName: 'synthetic-fixture/alpha',
    defaultBranch: 'main',
    commitSha: null,
    importedAt: '2026-10-21T10:00:00.000Z',
    partial: true,
    files: [
      {
        path: 'src/lease-policy.ts',
        sha: 'a'.repeat(40),
        size: Buffer.byteLength(sourceText),
        text: sourceText,
      },
    ],
    issues: [],
    pullRequests: [],
  });
  aliases.code = store.getRepositoryContext(context, repositories.alpha.id).files[0].sourceId;
  assert.ok(aliases.code);
  savedSource = store.getRepositorySource(context, aliases.code);
  const foreign = {
    mode: 'local',
    user: { id: randomUUID(), name: 'Synthetic foreign owner' },
    workspace: { id: randomUUID(), name: 'Synthetic foreign workspace', generation: 1 },
  };
  store.database
    .prepare(
      'INSERT INTO local_workspaces(id,owner_user_id,name,generation,status,created_at) VALUES(?,?,?,1,?,?)',
    )
    .run(
      foreign.workspace.id,
      foreign.user.id,
      foreign.workspace.name,
      'active',
      new Date().toISOString(),
    );
  const foreignRepository = store.createRepository(foreign, { name: foreignMarker });
  const foreignSession = store.createSession(foreign, { repositoryId: foreignRepository.id });
  const foreignEvent = {
    ...eventsFor(
      { repository: 'foreign', length: 1, base: 9998 },
      foreignRepository.id,
      foreignSession.id,
    )[0],
    output: [{ stream: 'stderr', ordinal: 0, text: `PostgresPoolConnectFailure ${foreignMarker}` }],
  };
  store.ingest(foreign, prepareEvents([foreignEvent]));
  const beforeReads = store.database.prepare('SELECT total_changes() AS count').get().count;

  stage = 'scope and original-evidence guards';
  await http(`/v1/memories/${ids.old}`, undefined, { expected: 401, credential: null });
  await http(
    '/v1/memories/search',
    { query: 'PostgresPoolConnectFailure', repositoryIds: [foreignRepository.id] },
    { expected: 404 },
  );
  const oldWindow = await http(`/v1/sessions/${sessionRecords.old.id}`);
  assert.equal(oldWindow.events.length, 100);
  assert.ok(
    !oldWindow.events.some((event) => event.eventId === ids.old),
    'Old-history target must be outside legacy latest100 window.',
  );
  const queued = (
    await http(`/v1/memories/${ids.pending}`, undefined, { schema: MemoryResponseSchema })
  ).memory;
  assert.equal(queued.representation, 'raw_event');
  assert.equal(queued.processingStatus, 'queued');
  memoryIntegrity(queued, [repositories.alpha.id]);
  const stored = (
    await http(`/v1/memories/${ids.stored}`, undefined, { schema: MemoryResponseSchema })
  ).memory;
  assert.deepEqual(stored, summary, 'Stored summary preference changed its provenance.');
  const late = await http(`/v1/events/${ids.late}`);
  assert.ok(late.event.output.some((chunk) => chunk.text.includes('LateLeaseExpiryTrace')));

  stage = 'fixed corpus API evaluation';
  for (const specification of cases) {
    const selected = specification.repositories.map((key) => repositories[key].id);
    const input = { query: specification.query, repositoryIds: selected, limit: 5 };
    const expected = specification.relevant.map((alias) => aliases[alias]);
    assert.ok(expected.every(Boolean), 'Corpus relevance references an unknown fixture alias.');
    const schema =
      specification.endpoint === 'notes'
        ? SessionNoteSearchResponseSchema
        : specification.endpoint === 'code'
          ? RepositorySourceSearchResponseSchema
          : SearchResponseSchema;
    const path =
      specification.endpoint === 'notes'
        ? '/v1/session-notes/search'
        : specification.endpoint === 'code'
          ? '/v1/repository-sources/search'
          : '/v1/memories/search';
    let returned;
    let final;
    for (const k of [1, 3, 5]) {
      const value = await http(path, { ...input, limit: k }, { schema });
      const actual = value.items.map((item) =>
        specification.endpoint === 'code' ? item.source.id : item.id,
      );
      assert.equal(
        new Set(actual).size,
        actual.length,
        'Search returned duplicate source identities.',
      );
      assert.ok(actual.length <= k);
      for (const item of value.items) {
        if (specification.endpoint === 'memories') memoryIntegrity(item, selected);
        else {
          scope(
            specification.endpoint === 'code' ? item.source.repositoryId : item.repositoryId,
            selected,
          );
          assert.ok(
            expected.includes(specification.endpoint === 'code' ? item.source.id : item.id),
            'Fixture-specific artifact search returned unknown provenance.',
          );
          if (specification.endpoint === 'notes')
            assert.deepEqual(
              item,
              savedNote,
              'Note retrieval changed its canonical authored record.',
            );
          else
            assert.deepEqual(
              item.source,
              savedSource.source,
              'Source retrieval changed its immutable file metadata.',
            );
        }
      }
      if (specification.scopeEmpty)
        assert.equal(actual.length, 0, 'Empty repository scope exposed evidence.');
      if (k === 5) {
        returned = actual;
        final = value;
      }
      const previous = results.find((row) => row.id === specification.id);
      if (previous) previous.metrics.push(metrics(actual, expected, k));
      else
        results.push({
          id: specification.id,
          category: specification.category,
          endpoint: specification.endpoint,
          query: specification.query,
          expectedRelevantIds: expected,
          metrics: [metrics(actual, expected, k)],
        });
    }
    const row = results.find((item) => item.id === specification.id);
    row.returnedIds = returned;
    row.missingRelevantIds = expected.filter((id) => !returned.includes(id));
    row.unjudgedOrNonrelevantIds = returned.filter((id) => !expected.includes(id));
    quality(
      expected.length ? expected.every((id) => returned.includes(id)) : returned.length === 0,
      specification.id,
      expected.length ? 'must_hit_relevant_ids_at5' : 'expected_empty_result',
    );
    if (
      specification.id === 'raw-match-prefers-summary' &&
      final.items.some((item) => item.id === ids.stored)
    )
      assert.deepEqual(
        final.items.find((item) => item.id === ids.stored),
        summary,
      );
    const ask = await http(
      '/v1/ask',
      {
        ...input,
        ...(specification.session ? { sessionId: sessionRecords[specification.session].id } : {}),
      },
      { schema: RecallAnswerSchema },
    );
    const selectedSession = specification.session
      ? sessionRecords[specification.session].id
      : undefined;
    answerIntegrity(ask, selected, selectedSession);
    const required = (specification.askRequired ?? specification.relevant).map(
      (alias) => aliases[alias],
    );
    const cited = ask.sources.map((source) => source.id);
    const stepped = [...new Set(ask.steps.flatMap((step) => step.sourceIds))];
    row.ask = {
      expectedAnchorIds: required,
      sourceIds: cited,
      stepSourceIds: stepped,
      missingCitationIds: required.filter((id) => !cited.includes(id)),
      missingStepIds: required.filter((id) => !stepped.includes(id)),
      eventSources: ask.sources.filter((source) => source.kind === 'event').length,
      steps: ask.steps.length,
      status: ask.status,
    };
    for (const anchor of required) {
      quality(cited.includes(anchor), specification.id, `ask_missing_citation:${anchor}`);
      quality(stepped.includes(anchor), specification.id, `ask_missing_step:${anchor}`);
    }
    if (!required.length)
      quality(
        ask.status === 'insufficient_evidence' && !cited.length,
        specification.id,
        'ask_expected_insufficient_evidence',
      );
    if (specification.enforceBudget)
      assert.ok(row.ask.eventSources <= 10, 'Ask exceeded its ten-event evidence budget.');
    answers.set(specification.id, ask);
  }

  stage = 'actual compiled CLI and MCP proof';
  mcp = startMcp();
  await mcp.initialize();
  const allKnownIds = [...eventRecords.keys(), aliases.journal, aliases.code, foreignEvent.eventId];
  for (const specification of cases.filter((item) => item.cli || item.mcp)) {
    const selected = specification.repositories.map((key) => repositories[key].id);
    const row = results.find((item) => item.id === specification.id);
    if (specification.cli) {
      const text = await cli(specification);
      const observed = allKnownIds.filter((id) => text.includes(id)).sort();
      assert.deepEqual(
        observed,
        [...new Set(answers.get(specification.id).sources.map((source) => source.id))].sort(),
        'CLI citations differ from the same authorized API Ask.',
      );
      row.cli = { citationIds: observed, agreesWithApi: true };
    }
    if (specification.mcp) {
      const found = await mcp.tool('search_memory', {
        query: specification.query,
        repositoryIds: selected,
        limit: 5,
      });
      assert.deepEqual(
        found.items.map((item) => item.id),
        row.returnedIds,
        'MCP ranking/source identities differ from the same API query.',
      );
      for (const memory of found.items) memoryIntegrity(memory, selected);
      row.mcp = { returnedIds: found.items.map((item) => item.id), agreesWithApi: true };
    }
  }
  const detail = await mcp.tool('get_memory', { id: ids.old });
  memoryIntegrity(detail.memory, [repositories.alpha.id]);
  assert.deepEqual(
    (await mcp.tool('search_memory', { query: 'PostgresPoolConnectFailure', repositoryIds: [] }))
      .items,
    [],
  );
  await mcp.tool(
    'search_memory',
    { query: 'PostgresPoolConnectFailure', repositoryIds: [foreignRepository.id] },
    true,
  );
  await mcp.tool(
    'search_memory',
    { query: 'PostgresPoolConnectFailure', repositoryId: repositories.alpha.id },
    true,
  );
  let cursor;
  let foundOld = false;
  let pages = 0;
  do {
    const page = await mcp.tool('get_session_context', {
      id: sessionRecords.old.id,
      limit: 10,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.session.id, sessionRecords.old.id);
    assert.ok(
      page.events.every(
        (event) =>
          event.sessionId === sessionRecords.old.id && event.repositoryId === repositories.alpha.id,
      ),
    );
    foundOld ||= page.events.some((event) => event.eventId === ids.old);
    cursor = page.page.olderCursor;
    pages++;
  } while (!foundOld && cursor && pages < 13);
  assert.ok(foundOld, 'MCP pagination failed to resolve the old original event.');
  await mcp.close();
  mcp = undefined;
  assert.equal(providerCalls, 0, 'Evaluation retrieval invoked enrichment.');
  assert.equal(
    store.database.prepare('SELECT total_changes() AS count').get().count,
    beforeReads,
    'Evaluation retrieval wrote evidence or processing state.',
  );
  assert.deepEqual(
    compiledSha256(),
    implementationSha256,
    'The evaluated compiled implementation changed during this run.',
  );
  report = {
    status: qualityFailures.length
      ? baseline && qualityFailures.every((failure) => failure.baselineAllowed)
        ? 'baseline_with_quality_failures'
        : 'quality_failed'
      : 'passed',
    baseline,
    syntheticFixturesOnly: true,
    fixtureCommandsExecuted: false,
    externalProvidersCalled: false,
    implementationSha256,
    corpusVersion,
    corpusSha256,
    baselineAllowedFailures,
    fixtureEvents: eventRecords.size,
    caseCount: cases.length,
    fixtureIds: aliases,
    interpretation:
      'Token-based lexical retrieval. Precision@K uses K as denominator, including empty slots; recall/hit/MRR are macro-averaged only over positive judgments. Note/file ranking is measured through its own endpoint, not a claimed unified semantic rank. Generic OR-match and summary-readiness effects remain visible in returned IDs. Boundary paraphrases are unsupported probes, not semantic-recall proof. Ask anchors/context are evaluated separately from search rank. No latency or model-quality claim.',
    overall: summarize(results),
    byCategory: Object.fromEntries(
      [...new Set(results.map((row) => row.category))].map((category) => [
        category,
        summarize(results.filter((row) => row.category === category)),
      ]),
    ),
    qualityFailures,
    integrityGates: 'passed',
    actualClients: { cli: true, mcpStdio: true, oldHistoryPages: pages },
    results,
    checkedAt: new Date().toISOString(),
  };
  if (
    qualityFailures.length &&
    (!baseline || qualityFailures.some((failure) => !failure.baselineAllowed))
  )
    process.exitCode = 1;
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown evaluation failure.';
  for (const secret of [token, foreignMarker])
    message = message.replaceAll(secret, '[redacted fixture]');
  console.error(
    `Retrieval evaluation integrity failure during ${stage}: ${message.slice(0, 1600)}`,
  );
  report = {
    status: 'integrity_failed',
    baseline,
    corpusVersion,
    corpusSha256,
    implementationSha256,
    baselineAllowedFailures,
    syntheticFixturesOnly: true,
    stage,
    qualityFailures,
    results,
    checkedAt: new Date().toISOString(),
  };
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  for (const [child, state] of processes)
    if (!state.closed) {
      try {
        await stop(child);
      } catch {
        cleanupFailed = true;
      }
    }
  await app.close();
  if (!cleanupFailed) {
    const entry = lstatSync(fixture);
    const target = realpathSync(fixture);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      target !== fixture ||
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-retrieval-evaluation-')
    )
      throw new Error('Unsafe retrieval evaluation cleanup target.');
    rmSync(target, { recursive: true, force: true });
  } else {
    report.status = 'integrity_failed';
    report.stage = 'owned process cleanup';
    report.integrityGates = 'failed';
    process.exitCode = 1;
  }
  safe(report);
  mkdirSync(join(root, '.memvora'), { recursive: true });
  const reportPath = join(
    root,
    '.memvora',
    baseline ? 'retrieval-baseline.json' : 'retrieval-evaluation.json',
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      baseline,
      cases: results.length,
      qualityFailures: qualityFailures.length,
      report: reportPath,
    }),
  );
}
