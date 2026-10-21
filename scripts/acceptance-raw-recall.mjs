import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Check } from 'typebox/value';
import {
  MemoryResponseSchema,
  RecallAnswerSchema,
  SearchResponseSchema,
} from '../packages/contracts/dist/index.js';
import {
  deriveObservedMemory,
  prepareEvents,
  runEnrichmentOnce,
} from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';

// Isolated synthetic evidence only. No captured command or real provider is executed.
const root = resolve(import.meta.dirname, '..');
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-raw-recall-'));
const token = randomBytes(32).toString('hex');
const query = 'MemvoraRawRecallZXQ7839PendingFailure';
const secret = 'raw-recall-fixture-secret';
const foreignMarker = 'ForeignRawRecallMustRemainHidden';
const preferredTitle = 'Synthetic stored summary replaces raw representation';
const store = new SqliteEvidenceStore(':memory:');
const children = new Set();
const childStates = new WeakMap();
const pending = new Map();
let rpcId = 0;
let mcp;
let protocolBuffer = '';
let protocolFailure;
let backgroundFailure;
let providerCalls = 0;
let providerBehavior = 'fail';
let targetEventId;
let api;
let web;
const environment = { ...process.env, MEMVORA_DATA_DIR: fixture, NEXT_TELEMETRY_DISABLED: '1' };
for (const key of Object.keys(environment))
  if (
    key === 'MEMVORA_LOCAL_TOKEN' ||
    key === 'AI_API_KEY' ||
    key === 'DATABASE_URL' ||
    key.startsWith('GITHUB_') ||
    key.startsWith('MEMVORA_AI_')
  )
    delete environment[key];
writeFileSync(join(fixture, 'local-token'), `${token}\n`, { mode: 0o600 });
// Unscoped Ask must not inherit an unrelated ancestor capture binding.
writeFileSync(join(fixture, '.git'), 'gitdir: synthetic-boundary-not-used\n');

function safe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const hidden of [token, secret, foreignMarker])
    assert.ok(!text.includes(hidden), 'A credential or private fixture value was exposed.');
}
async function fixtureProvider(event) {
  providerCalls++;
  assert.equal(event.eventId, targetEventId, 'The wrong synthetic job was processed.');
  if (providerBehavior === 'fail') throw new Error('Synthetic enrichment outage.');
  return {
    ...deriveObservedMemory(event),
    mode: 'ai',
    label: 'AI summary — synthetic fixture, no remote model called',
    title: preferredTitle,
    summary: `${query}: a synthetic stored summary with original evidence citations.`,
    provenance: {
      provider: 'synthetic-fixture',
      model: 'fixture-only',
      promptVersion: 'raw-recall-v1',
    },
  };
}
const app = buildApp({ store, token, embeddedWorker: false, enricher: fixtureProvider });

async function waitForClose(state, milliseconds) {
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
  const state = childStates.get(child);
  if (!state) throw new Error('Refusing to stop an unowned raw-recall process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitForClose(state, 1000)) return;
      throw new Error('Raw-recall process cleanup could not be confirmed. Fixture retained.');
    }
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((done) =>
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000 },
            () => done(),
          ),
        );
    } else {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== 'ESRCH')
            throw new Error('Raw-recall process group cleanup failed. Fixture retained.');
        }
        if (signal === 'SIGTERM') await waitForClose(state, 1000);
      }
    }
    if (!(await waitForClose(state, 3000)))
      throw new Error('Raw-recall process cleanup could not be confirmed. Fixture retained.');
  })();
  return state.stopping;
}
function requestStop(child) {
  void stop(child).catch(() => {});
}
function spawnNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: fixture,
    env: environment,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.add(child);
  const state = { closed: false, done: undefined, stopping: undefined };
  state.done = new Promise((done) =>
    child.once('close', () => {
      state.closed = true;
      children.delete(child);
      done();
    }),
  );
  childStates.set(child, state);
  return child;
}
async function cli(repositoryId, expected = 0) {
  const child = spawnNode([
    resolve(root, 'apps/cli/dist/index.js'),
    'ask',
    query,
    ...(repositoryId === undefined ? [] : ['--repository', repositoryId]),
  ]);
  let stdout = '';
  let stderr = '';
  let exceeded = false;
  let timedOut = false;
  const collect = (channel) => (chunk) => {
    if (channel === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout + stderr, 'utf8') > 256 * 1024) {
      exceeded = true;
      requestStop(child);
    }
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  const timer = setTimeout(() => {
    timedOut = true;
    requestStop(child);
  }, 20_000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(code, expected, 'Compiled raw-recall CLI returned an unexpected status.');
    assert.equal(signal, null);
    assert.equal(exceeded, false);
    assert.equal(timedOut, false);
    safe(stdout);
    safe(stderr);
    if (expected) {
      assert.equal(stdout.trim(), '');
      assert.ok(stderr.trim());
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((done, reject) => socket.close((error) => (error ? reject(error) : done())));
  return port;
}
async function request(path, { body, expected = 200, website = false, schema } = {}) {
  if (backgroundFailure) throw backgroundFailure;
  const response = await fetch(new URL(path, website ? web : api), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      ...(website ? { origin: web } : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(
    response.status,
    expected,
    'Raw-recall HTTP boundary returned an unexpected status.',
  );
  const value = await response.json();
  safe(value);
  if (schema && expected < 300)
    assert.ok(Check(schema, value), 'Raw recall violated the shared response schema.');
  return value;
}
function failProtocol(error) {
  protocolFailure = error;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
function call(method, params) {
  if (protocolFailure) return Promise.reject(protocolFailure);
  const id = ++rpcId;
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Raw-recall MCP timed out.'));
    }, 15_000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function tool(name, input, errorExpected = false) {
  const result = await call('tools/call', { name, arguments: input });
  safe(result);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 128 * 1024);
  if (errorExpected) {
    assert.equal(result.isError, true);
    return null;
  }
  assert.ok(!result.isError, 'Raw-recall MCP returned an error.');
  return JSON.parse(result.content[0].text);
}
function captured(repositoryId, sessionId, output) {
  return {
    eventId: randomUUID(),
    repositoryId,
    sessionId,
    sequence: 1,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: {
      executable: 'synthetic-raw-recall-fixture',
      args: [],
      shell: 'not_executed_fixture',
    },
    cwd: 'synthetic-project',
    git: { commitSha: 'a'.repeat(40), dirty: true },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stderr', ordinal: 0, text: output }],
    diffs: [],
  };
}
function assertSources(value, eventId, repositoryId) {
  assert.equal(value.id, eventId);
  assert.equal(value.repositoryId, repositoryId);
  assert.deepEqual(
    value.sources.map((source) => source.id),
    [eventId],
  );
  assert.ok(value.steps.every((step) => step.sourceIds.every((id) => id === eventId)));
  assert.ok(value.uncertainty.length);
}
function assertAnswer(value, ids) {
  assert.equal(value.status, ids.length ? 'answered' : 'insufficient_evidence');
  assert.deepEqual([...new Set(value.sources.map((source) => source.id))].sort(), [...ids].sort());
  assert.ok(value.steps.every((step) => step.sourceIds.every((id) => ids.includes(id))));
}

try {
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Synthetic raw-recall repository' });
  const otherRepository = store.createRepository(context, { name: 'Synthetic empty recall scope' });
  const session = store.createSession(context, { repositoryId: repository.id });
  const emptySession = store.createSession(context, { repositoryId: repository.id });
  const otherSession = store.createSession(context, { repositoryId: repository.id });
  const event = captured(
    repository.id,
    session.id,
    `${query}: labeled synthetic failure.\npassword=${secret}`,
  );
  targetEventId = event.eventId;
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
  const foreignEvent = captured(
    foreignRepository.id,
    foreignSession.id,
    `${query} ${foreignMarker}`,
  );
  store.ingest(foreign, prepareEvents([foreignEvent]));
  api = await app.listen({ host: '127.0.0.1', port: 0 });
  environment.MEMVORA_API_URL = api;
  const accepted = await request('/v1/events/batch', {
    body: { schemaVersion: 1, events: [event] },
  });
  assert.deepEqual(accepted.acknowledgedEventIds, [event.eventId]);
  assert.equal(
    store.database.prepare('SELECT count(*) AS count FROM local_memories').get().count,
    0,
  );

  mcp = spawnNode([resolve(root, 'apps/mcp/dist/index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  mcp.stderr.on('data', (chunk) => {
    try {
      safe(String(chunk));
    } catch {
      failProtocol(new Error('MCP diagnostics exposed private fixture content.'));
    }
  });
  mcp.stdout.on('data', (chunk) => {
    protocolBuffer += chunk;
    if (Buffer.byteLength(protocolBuffer, 'utf8') > 512 * 1024)
      return failProtocol(new Error('Raw-recall MCP buffer exceeded.'));
    while (protocolBuffer.includes('\n')) {
      const end = protocolBuffer.indexOf('\n');
      const line = protocolBuffer.slice(0, end);
      protocolBuffer = protocolBuffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        safe(line);
        const value = JSON.parse(line);
        const waiter = pending.get(value.id);
        if (waiter) {
          pending.delete(value.id);
          clearTimeout(waiter.timer);
          if (value.error) waiter.reject(new Error('Raw-recall MCP protocol returned an error.'));
          else waiter.resolve(value.result);
        }
      } catch {
        failProtocol(new Error('Raw-recall MCP stdout was not safe protocol JSON.'));
      }
    }
  });
  mcp.on('error', () => failProtocol(new Error('Raw-recall MCP process failed.')));
  mcp.on('exit', () => {
    if (pending.size) failProtocol(new Error('Raw-recall MCP exited early.'));
  });
  await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'memvora-raw-recall-acceptance', version: '1.0.0' },
  });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await call('tools/list', {})).tools;
  for (const name of ['search_memory', 'get_memory'])
    assert.ok(
      tools.some((definition) => definition.name === name && definition.annotations?.readOnlyHint),
    );

  web = `http://127.0.0.1:${await freePort()}`;
  const website = spawnNode(
    [
      resolve(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      new URL(web).port,
    ],
    { cwd: resolve(root, 'apps/web') },
  );
  let websiteBytes = 0;
  const websiteLog = (chunk) => {
    websiteBytes += chunk.length;
    try {
      safe(String(chunk));
    } catch {
      backgroundFailure = new Error('Website diagnostics exposed private fixture content.');
    }
    if (websiteBytes > 256 * 1024) {
      backgroundFailure = new Error('Website diagnostics exceeded their budget.');
      requestStop(website);
    }
  };
  website.stdout.on('data', websiteLog);
  website.stderr.on('data', websiteLog);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backgroundFailure) throw backgroundFailure;
    if (website.exitCode !== null)
      throw new Error('Compiled raw-recall website exited before startup.');
    try {
      const response = await fetch(`${web}/api/status`, {
        redirect: 'error',
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Poll only this owned loopback server. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, 'Compiled raw-recall website did not become ready.');

  const searchInput = { query, repositoryIds: [repository.id], limit: 5 };
  async function checkStage(status, summaryExpected = false) {
    const calls = providerCalls;
    const changes = store.database.prepare('SELECT total_changes() AS count').get().count;
    const found = await request('/v1/memories/search', {
      body: searchInput,
      schema: SearchResponseSchema,
    });
    assert.equal(found.items.length, 1);
    const memory = found.items[0];
    assertSources(memory, event.eventId, repository.id);
    if (summaryExpected) {
      assert.equal(memory.representation ?? 'summary', 'summary');
      assert.equal(memory.title, preferredTitle);
      assert.equal(memory.mode, 'ai');
    } else {
      assert.equal(memory.representation, 'raw_event');
      assert.equal(memory.processingStatus, status);
      assert.equal(memory.mode, 'observed');
      assert.match(memory.label, /captured|raw/i);
      assert.match(memory.uncertainty.join(' '), /not a stored|on.read/i);
    }
    const detail = await request(`/v1/memories/${event.eventId}`, { schema: MemoryResponseSchema });
    assert.deepEqual(detail.memory, memory);
    const ask = await request('/v1/ask', { body: searchInput, schema: RecallAnswerSchema });
    assertAnswer(ask, [event.eventId]);
    const terminal = await cli(repository.id);
    assert.ok(terminal.includes(event.eventId));
    assert.ok(terminal.includes(query));
    const mcpSearch = await tool('search_memory', searchInput);
    assert.equal(mcpSearch.items.length, 1);
    assertSources(mcpSearch.items[0], event.eventId, repository.id);
    assert.equal(
      mcpSearch.items[0].representation ?? 'summary',
      summaryExpected ? 'summary' : 'raw_event',
    );
    const mcpDetail = await tool('get_memory', { id: event.eventId });
    assertSources(mcpDetail.memory, event.eventId, repository.id);
    assert.equal(
      mcpDetail.memory.representation ?? 'summary',
      summaryExpected ? 'summary' : 'raw_event',
    );
    const webAsk = await request('/api/ask', {
      body: searchInput,
      website: true,
      schema: RecallAnswerSchema,
    });
    assertAnswer(webAsk, [event.eventId]);
    assert.equal(providerCalls, calls, 'A retrieval path called the enrichment provider.');
    assert.equal(
      store.database.prepare('SELECT total_changes() AS count').get().count,
      changes,
      'A retrieval path wrote to evidence storage.',
    );
  }
  await checkStage('queued');
  assert.equal(providerCalls, 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    store.database
      .prepare('UPDATE local_jobs SET available_at=? WHERE event_id=?')
      .run('2000-01-01T00:00:00.000Z', event.eventId);
    assert.equal(await runEnrichmentOnce(store, fixtureProvider), true);
  }
  assert.equal(providerCalls, 3);
  assert.equal(store.jobs(context, { sessionId: session.id })[0].status, 'failed');
  await checkStage('failed');
  assert.equal(
    store.database.prepare('SELECT count(*) AS count FROM local_memories').get().count,
    0,
  );

  await request(`/v1/jobs/${event.eventId}/retry`, { body: {}, expected: 202 });
  providerBehavior = 'success';
  store.database
    .prepare('UPDATE local_jobs SET available_at=? WHERE event_id=?')
    .run('2000-01-01T00:00:00.000Z', event.eventId);
  assert.equal(await runEnrichmentOnce(store, fixtureProvider), true);
  assert.equal(providerCalls, 4);
  await checkStage('ready', true);
  const second = captured(
    repository.id,
    otherSession.id,
    `${query}: a second labeled raw candidate.`,
  );
  await request('/v1/events/batch', { body: { schemaVersion: 1, events: [second] } });
  const combined = await request('/v1/memories/search', {
    body: { ...searchInput, limit: 2 },
    schema: SearchResponseSchema,
  });
  assert.deepEqual(
    combined.items.map((item) => item.id).sort(),
    [event.eventId, second.eventId].sort(),
  );
  assert.equal(combined.items.find((item) => item.id === event.eventId).title, preferredTitle);
  assert.equal(
    combined.items.find((item) => item.id === second.eventId).representation,
    'raw_event',
  );
  assert.equal(new Set(combined.items.map((item) => item.id)).size, combined.items.length);

  const noCalls = providerCalls;
  const beforeScopeReads = store.database.prepare('SELECT total_changes() AS count').get().count;
  for (const repositoryIds of [[], [otherRepository.id]]) {
    const empty = await request('/v1/memories/search', {
      body: { query, repositoryIds },
      schema: SearchResponseSchema,
    });
    assert.deepEqual(empty.items, []);
    assertAnswer(
      await request('/v1/ask', { body: { query, repositoryIds }, schema: RecallAnswerSchema }),
      [],
    );
    assert.deepEqual((await tool('search_memory', { query, repositoryIds })).items, []);
  }
  assertAnswer(
    await request('/v1/ask', {
      body: { query, sessionId: session.id },
      schema: RecallAnswerSchema,
    }),
    [event.eventId],
  );
  assertAnswer(
    await request('/v1/ask', {
      body: { query, sessionId: emptySession.id },
      schema: RecallAnswerSchema,
    }),
    [],
  );
  assertAnswer(
    await request('/v1/ask', {
      body: { query, sessionId: session.id, repositoryIds: [otherRepository.id] },
      schema: RecallAnswerSchema,
    }),
    [],
  );
  await request('/v1/memories/search', {
    body: { query, repositoryIds: [foreignRepository.id] },
    expected: 404,
  });
  await request(`/v1/memories/${foreignEvent.eventId}`, { expected: 404 });
  await tool('search_memory', { query, repositoryIds: [foreignRepository.id] }, true);
  await tool('get_memory', { id: foreignEvent.eventId }, true);
  await cli(foreignRepository.id, 1);
  assert.equal(providerCalls, noCalls);
  assert.equal(
    store.database.prepare('SELECT total_changes() AS count').get().count,
    beforeScopeReads,
  );

  store.deleteSession(context, session.id);
  await request(`/v1/memories/${event.eventId}`, { expected: 404 });
  await request(`/v1/events/${event.eventId}`, { expected: 404 });
  await tool('get_memory', { id: event.eventId }, true);
  const remaining = await request('/v1/memories/search', {
    body: searchInput,
    schema: SearchResponseSchema,
  });
  assert.deepEqual(
    remaining.items.map((item) => item.id),
    [second.eventId],
  );
  assert.deepEqual(
    (await tool('search_memory', searchInput)).items.map((item) => item.id),
    [second.eventId],
  );
  const afterSessionDeletion = await cli(repository.id);
  assert.ok(!afterSessionDeletion.includes(event.eventId));
  assert.ok(afterSessionDeletion.includes(second.eventId));
  await request('/api/ask', {
    website: true,
    body: { ...searchInput, sessionId: session.id },
    expected: 404,
  });
  store.deleteRepository(context, repository.id);
  const afterDeletion = store.database.prepare('SELECT total_changes() AS count').get().count;
  assert.deepEqual(
    (await request('/v1/memories/search', { body: { query }, schema: SearchResponseSchema })).items,
    [],
  );
  assertAnswer(await request('/v1/ask', { body: { query }, schema: RecallAnswerSchema }), []);
  assertAnswer(
    await request('/api/ask', { website: true, body: { query }, schema: RecallAnswerSchema }),
    [],
  );
  assert.deepEqual((await tool('search_memory', { query })).items, []);
  await tool('get_memory', { id: second.eventId }, true);
  await request(`/v1/memories/${second.eventId}`, { expected: 404 });
  await request('/v1/memories/search', { body: searchInput, expected: 404 });
  await cli(repository.id, 1);
  const noEvidence = await cli();
  assert.ok(!noEvidence.includes(event.eventId) && !noEvidence.includes(second.eventId));
  assert.equal(providerCalls, noCalls);
  assert.equal(
    store.database.prepare('SELECT total_changes() AS count').get().count,
    afterDeletion,
  );
  const report = {
    completedAt: new Date().toISOString(),
    mode: 'isolated_synthetic_raw_recall_fixture',
    checks: [
      'pending_job_raw_error_recall_before_any_memory_exists',
      'failed_job_raw_error_recall_and_source_detail',
      'compiled_cli_actual_stdio_mcp_and_web_ask_agree',
      'stored_summary_preferred_with_event_dedup_before_limit',
      'empty_repository_session_and_foreign_scope_fences',
      'original_event_citations_and_secret_redaction',
      'session_and_repository_deletion_remove_raw_and_derived_results',
      'reads_never_call_provider_or_write_evidence',
    ],
    notice:
      'Only explicitly synthetic evidence and an in-process failing/successful provider fixture were used. No captured command was executed, no live data was read, and no GitHub or external AI service was called.',
  };
  safe(report);
  mkdirSync(resolve(root, '.memvora'), { recursive: true });
  writeFileSync(
    resolve(root, '.memvora/raw-recall-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  await Promise.all([...children].map(stop));
  await app.close();
  const target = realpathSync(fixture);
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith('memvora-raw-recall-'))
    throw new Error('Refusing to remove an unexpected raw-recall fixture path.');
  rmSync(target, { recursive: true, force: true });
}
