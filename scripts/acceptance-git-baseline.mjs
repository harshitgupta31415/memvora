import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { Check } from 'typebox/value';
import {
  EventAckSchema,
  EventResponseSchema,
  EventSchema,
  SessionEventsPageSchema,
  SessionHandoverSchema,
  SessionRecapSchema,
  SessionSynthesisInputSchema,
} from '../packages/contracts/dist/index.js';
import { buildSessionSynthesisInput, LocalMemvora } from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';

// Actual Git and captured commands run only in owned temporary repositories. The API is disposable.
const root = resolve(import.meta.dirname, '..');
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-git-baseline-'));
const captureRoot = join(fixture, 'synthetic-tracked-repository');
const unbornRoot = join(fixture, 'synthetic-unborn-repository');
const token = randomBytes(32).toString('hex');
const excludedMarker = 'SyntheticExcludedBaselineFilePrivateValue';
const untrackedMarker = 'SyntheticUntrackedBaselineFilePrivateValue';
const preexistingMarker = 'PreexistingBaselineTrackedEdit';
const capturedMarker = 'DuringCapturedBaselineTrackedEdit';
const children = new Map();
const store = new SqliteEvidenceStore(':memory:');
const service = new LocalMemvora(store);
let providerCalls = 0;
const app = buildApp({
  store,
  token,
  embeddedWorker: false,
  enricher: async () => {
    providerCalls++;
    throw new Error('The baseline fixture must not invoke an enrichment provider.');
  },
});
let apiOrigin;
let mcp;
let stage = 'fixture setup';
let report = { status: 'failed', syntheticFixturesOnly: true };

const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  const upper = name.toUpperCase();
  if (
    /^(MEMVORA_|AI_|GH_|GITHUB_|GIT_|DOTENV_|NPM_CONFIG_)/u.test(upper) ||
    ['NODE_PATH', 'NODE_OPTIONS', 'DATABASE_URL'].includes(upper)
  )
    delete environment[name];
}
Object.assign(environment, {
  MEMVORA_LOCAL_TOKEN: token,
  MEMVORA_DATA_DIR: join(fixture, 'synthetic-server-credential'),
  MEMVORA_AI_ENABLED: 'false',
  MEMVORA_SESSION_SYNTHESIS_ENABLED: 'false',
  GIT_CEILING_DIRECTORIES: fixture,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(fixture, 'nonexistent-global-git-config'),
  NODE_OPTIONS: '--max-old-space-size=1536 --v8-pool-size=1',
  UV_THREADPOOL_SIZE: '2',
});
function safe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [token, excludedMarker, untrackedMarker])
    assert.ok(
      !text.includes(secret),
      'Private fixture data reached a retained or displayed result.',
    );
}
function withinFixture(path) {
  const difference = relative(fixture, realpathSync(path));
  assert.ok(
    difference &&
      difference !== '..' &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference),
  );
}
function gitExecutable() {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  for (const value of (process.env[pathKey] ?? '').split(delimiter)) {
    const directory = value.trim().replace(/^"(.*)"$/u, '$1');
    if (!isAbsolute(directory) || (process.platform === 'win32' && /^[\\/]{2}/u.test(directory)))
      continue;
    const path = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return path;
    } catch {
      /* Try another absolute PATH entry. */
    }
  }
  throw new Error('This actual-Git acceptance requires Git on an absolute PATH entry.');
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
  const state = children.get(child);
  if (!state) throw new Error('Refusing cleanup of an unowned Git-baseline process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitClosed(state, 1000)) return;
      throw new Error('Git-baseline process cleanup could not be confirmed.');
    }
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((done) =>
          execFile(
            join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000, maxBuffer: 16384 },
            () => done(),
          ),
        );
    } else {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (state.closed) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== 'ESRCH')
            throw new Error('Git-baseline process group cleanup failed.');
        }
        if (signal === 'SIGTERM' && (await waitClosed(state, 1000))) return;
      }
    }
    if (!(await waitClosed(state, 3000))) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw new Error('Git-baseline process cleanup could not be confirmed; fixture retained.');
    }
  })();
  return state.stopping;
}
function start(executable, args, { cwd = captureRoot, interactive = false } = {}) {
  withinFixture(cwd);
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const state = { closed: false, failed: false, bytes: 0, stdout: '', stderr: '' };
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
  children.set(child, state);
  return child;
}
async function run(executable, args, options = {}) {
  const child = start(executable, args, options);
  const state = children.get(child);
  let timer;
  try {
    const result = await Promise.race([
      state.done,
      new Promise((_done, reject) => {
        timer = setTimeout(() => {
          void stop(child)
            .finally(() => reject(new Error('Git-baseline child timed out.')))
            .catch(() => {});
        }, 30_000);
      }),
    ]);
    assert.equal(
      result.code,
      options.expected ?? 0,
      'An actual fixture command returned an unexpected exit.',
    );
    assert.equal(result.signal, null);
    assert.equal(state.failed, false);
    safe(state.stdout);
    safe(state.stderr);
    return { stdout: state.stdout, stderr: state.stderr };
  } finally {
    clearTimeout(timer);
    if (state.stopping) await state.stopping;
  }
}
async function cli(args, options = {}) {
  return run(process.execPath, [join(root, 'apps/cli/dist/index.js'), ...args], options);
}
async function json(path, { body, expected = 200, schema } = {}) {
  const response = await fetch(new URL(path, apiOrigin), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, 'The Git-baseline API returned an unexpected status.');
  const reader = response.body?.getReader();
  assert.ok(reader);
  const chunks = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('Fixture response exceeded its bound.');
    }
    chunks.push(chunk.value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  safe(value);
  if (schema) assert.ok(Check(schema, value));
  return value;
}
function binding(directory) {
  return JSON.parse(readFileSync(join(directory, '.memvora', 'config.json'), 'utf8'));
}
function localEvents(directory) {
  const database = new DatabaseSync(join(directory, '.memvora', 'outbox.sqlite'), {
    readOnly: true,
  });
  try {
    return database
      .prepare('SELECT id,payload,synced FROM executions ORDER BY sequence')
      .all()
      .map((row) => {
        const event = JSON.parse(row.payload);
        assert.ok(Check(EventSchema, event));
        assert.equal(row.id, event.eventId);
        assert.equal(row.synced, 1);
        safe(event);
        return event;
      });
  } finally {
    database.close();
  }
}
async function capture(command, directory = captureRoot) {
  await cli(['run', '--', ...command], { cwd: directory });
  const event = localEvents(directory).at(-1);
  const { event: accepted } = await json(`/v1/events/${event.eventId}`, {
    schema: EventResponseSchema,
  });
  assert.deepEqual(accepted, event, 'Accepted evidence differs from its original local event.');
  assert.equal(event.outcome.kind, 'completed');
  assert.equal(event.outcome.exitCode, 0);
  return event;
}
function phases(event, baseline, afterCommit) {
  assert.equal(event.git.commitSha, baseline);
  assert.equal(event.git.afterCommitSha, afterCommit);
  assert.equal(event.git.error, undefined);
  assert.equal(event.capture.complete, true);
  assert.deepEqual(
    event.diffs.map((diff) => diff.phase),
    ['before', 'after'],
  );
  for (const diff of event.diffs) {
    assert.equal(diff.baselineCommitSha, baseline);
    assert.equal(diff.truncatedBytes, 0);
  }
  return { before: event.diffs[0].text, after: event.diffs[1].text };
}
function startMcp() {
  const child = start(process.execPath, [join(root, 'apps/mcp/dist/index.js')], {
    interactive: true,
  });
  const waiting = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let nextId = 0;
  let failure;
  const fail = () => {
    failure ??= new Error('Git-baseline MCP protocol failed.');
    for (const waiter of waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiting.clear();
  };
  child.on('error', fail);
  child.once('close', () => {
    if (waiting.size) fail();
  });
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > 256 * 1024) return fail();
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
          if (message.error) waiter.reject(new Error('Git-baseline MCP request failed.'));
          else waiter.resolve(message.result);
        }
      } catch {
        fail();
      }
    }
  });
  function call(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolveCall, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('Git-baseline MCP timed out.'));
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
        clientInfo: { name: 'memvora-synthetic-git-baseline-acceptance', version: '1.0.0' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      const { tools } = await call('tools/list', {});
      for (const name of ['get_session_context', 'get_session_recap'])
        assert.ok(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint);
    },
    async tool(name, input) {
      const result = await call('tools/call', { name, arguments: input });
      safe(result);
      assert.ok(!result.isError, 'Read-only baseline MCP retrieval failed.');
      assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 96 * 1024);
      return JSON.parse(result.content[0].text);
    },
    async close() {
      child.stdin.end();
      assert.ok(await waitClosed(children.get(child), 5000));
      assert.equal(child.exitCode, 0);
      buffer += decoder.end();
      assert.equal(buffer.trim(), '');
      if (failure) throw failure;
    },
  };
}

try {
  mkdirSync(captureRoot);
  mkdirSync(unbornRoot);
  const git = gitExecutable();
  const gitRun = async (args, directory = captureRoot) =>
    (await run(git, args, { cwd: directory })).stdout.trim();
  for (const directory of [captureRoot, unbornRoot]) {
    await gitRun(['init', '-q'], directory);
    for (const [key, value] of [
      ['user.name', 'harshitgupta31415'],
      ['user.email', 'harshitgupta3.1415@gmail.com'],
      ['commit.gpgSign', 'false'],
      ['core.hooksPath', join(fixture, 'nonexistent-hooks')],
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
      ['core.attributesFile', join(fixture, 'nonexistent-attributes')],
    ])
      await gitRun(['config', '--local', key, value], directory);
  }
  writeFileSync(join(captureRoot, 'tracked.txt'), 'BaselineOriginalLine\n');
  writeFileSync(join(captureRoot, '.gitattributes'), '* text eol=lf -filter\n');
  writeFileSync(join(captureRoot, '.env.baseline-fixture'), 'EXCLUDED=original-placeholder\n');
  await gitRun(['add', '-f', '--', 'tracked.txt', '.gitattributes', '.env.baseline-fixture']);
  await gitRun(['commit', '-qm', 'Synthetic baseline fixture initial commit']);
  const initialSha = await gitRun(['rev-parse', '--verify', 'HEAD']);
  assert.match(initialSha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  writeFileSync(join(captureRoot, 'tracked.txt'), `BaselineOriginalLine\n${preexistingMarker}\n`);
  writeFileSync(join(captureRoot, '.env.baseline-fixture'), `EXCLUDED=${excludedMarker}\n`);
  writeFileSync(join(captureRoot, 'untracked-private.txt'), `${untrackedMarker}\n`);
  apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  environment.MEMVORA_API_URL = apiOrigin;
  const repository = service.createRepository({ name: 'Synthetic fixed-baseline Git repository' });
  const unbornRepository = service.createRepository({ name: 'Synthetic unborn Git repository' });
  await cli(['init', '--repository-id', repository.id]);
  await cli(['init', '--repository-id', unbornRepository.id], { cwd: unbornRoot });
  const mainBinding = binding(captureRoot);
  const unbornBinding = binding(unbornRoot);
  const context = service.context();

  stage = 'pre-existing tracked edit and captured append share one fixed baseline';
  const edited = await capture([
    process.execPath,
    '-e',
    `require('node:fs').appendFileSync('tracked.txt',${JSON.stringify(`${capturedMarker}\n`)});console.log('Synthetic tracked edit captured.');`,
  ]);
  const editDiffs = phases(edited, initialSha, initialSha);
  assert.ok(editDiffs.before.includes(preexistingMarker));
  assert.ok(!editDiffs.before.includes(capturedMarker));
  assert.ok(
    editDiffs.after.includes(preexistingMarker) && editDiffs.after.includes(capturedMarker),
  );
  assert.notEqual(editDiffs.before, editDiffs.after);

  stage = 'staging alone preserves tracked-content snapshot text';
  const staged = await capture([git, 'add', '--', 'tracked.txt']);
  const stagedDiffs = phases(staged, initialSha, initialSha);
  assert.equal(stagedDiffs.before, stagedDiffs.after);
  assert.equal(stagedDiffs.after, editDiffs.after);
  assert.ok(
    (await gitRun(['diff', '--cached', '--name-only'])).split(/\r?\n/u).includes('tracked.txt'),
  );

  stage = 'commit moves HEAD but cannot erase the patch against its pre-command SHA';
  const committed = await capture([
    git,
    'commit',
    '-qm',
    'Synthetic captured baseline fixture commit',
  ]);
  const committedSha = await gitRun(['rev-parse', '--verify', 'HEAD']);
  assert.notEqual(committedSha, initialSha);
  const commitDiffs = phases(committed, initialSha, committedSha);
  assert.equal(commitDiffs.before, commitDiffs.after);
  assert.ok(
    commitDiffs.after.includes(preexistingMarker) && commitDiffs.after.includes(capturedMarker),
  );

  stage = 'soft reset moves HEAD without inventing a working-tree content change';
  const reset = await capture([git, 'reset', '--soft', initialSha]);
  const resetDiffs = phases(reset, committedSha, initialSha);
  assert.equal(resetDiffs.before, '');
  assert.equal(resetDiffs.after, '');
  assert.equal(await gitRun(['rev-parse', '--verify', 'HEAD']), initialSha);

  stage = 'unborn repository keeps execution and explicitly unavailable baseline evidence';
  const unborn = await capture(
    [process.execPath, '-e', "console.log('Synthetic unborn repository check.');"],
    unbornRoot,
  );
  assert.equal(unborn.git.commitSha, null);
  assert.equal(unborn.git.afterCommitSha, null);
  assert.equal(unborn.capture.complete, false);
  assert.ok(unborn.git.error);
  assert.deepEqual(unborn.diffs, []);

  stage = 'legacy payload replay preserves its stored bytes and digest without invented metadata';
  const legacy = {
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: mainBinding.sessionId,
    sequence: 5,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: {
      executable: 'legacy-baseline-synthetic-metadata',
      args: [],
      shell: 'fixture_not_executed',
    },
    cwd: '.',
    git: { commitSha: initialSha, dirty: true },
    outcome: { kind: 'completed', exitCode: 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [],
    diffs: [
      { phase: 'before', text: 'Synthetic legacy snapshot text.', truncatedBytes: 0 },
      { phase: 'after', text: 'Synthetic legacy snapshot text.', truncatedBytes: 0 },
    ],
  };
  const batch = { schemaVersion: 1, events: [legacy] };
  const firstAck = await json('/v1/events/batch', { body: batch, schema: EventAckSchema });
  assert.deepEqual(firstAck.acknowledgedEventIds, [legacy.eventId]);
  const persistedLegacy = store.database
    .prepare('SELECT digest,payload_json,received_at FROM local_events WHERE id=?')
    .get(legacy.eventId);
  const replayAck = await json('/v1/events/batch', { body: batch, schema: EventAckSchema });
  assert.deepEqual(replayAck.acknowledgedEventIds, [legacy.eventId]);
  assert.deepEqual(
    store.database
      .prepare('SELECT digest,payload_json,received_at FROM local_events WHERE id=?')
      .get(legacy.eventId),
    persistedLegacy,
  );
  const legacyRead = (await json(`/v1/events/${legacy.eventId}`, { schema: EventResponseSchema }))
    .event;
  assert.deepEqual(legacyRead, legacy);
  assert.ok(!Object.hasOwn(legacyRead.git, 'afterCommitSha'));
  assert.ok(legacyRead.diffs.every((diff) => !Object.hasOwn(diff, 'baselineCommitSha')));

  stage = 'API CLI MCP and handover preserve fixed-baseline provenance on read';
  const beforeReads = store.database.prepare('SELECT total_changes() AS count').get().count;
  const captured = [edited, staged, committed, reset];
  const expected = [...captured, legacy];
  const apiPage = await json(`/v1/sessions/${mainBinding.sessionId}/events?limit=10`, {
    schema: SessionEventsPageSchema,
  });
  assert.deepEqual(apiPage.events, expected);
  const cliPage = JSON.parse(
    (await cli(['session', 'show', mainBinding.sessionId, '--limit', '10'])).stdout,
  );
  assert.ok(Check(SessionEventsPageSchema, cliPage));
  assert.deepEqual(cliPage.events, expected);
  const recap = await json(`/v1/sessions/${mainBinding.sessionId}/recap`, {
    schema: SessionRecapSchema,
  });
  const cliRecap = JSON.parse(
    (await cli(['session', 'recap', mainBinding.sessionId, '--json'])).stdout,
  );
  assert.ok(Check(SessionRecapSchema, cliRecap));
  assert.deepEqual(cliRecap.steps, recap.steps);
  assert.deepEqual(
    recap.sources.map((source) => source.id),
    expected.map((event) => event.eventId),
  );
  const legacyStep = recap.steps.find((step) => step.eventId === legacy.eventId);
  assert.ok(
    legacyStep && !/snapshot texts match|snapshots match/iu.test(legacyStep.diffSummary),
    'Unknown legacy baselines must not gain a verified snapshot comparison.',
  );
  const handover = await json(`/v1/sessions/${mainBinding.sessionId}/handover`, {
    schema: SessionHandoverSchema,
  });
  const exported = JSON.parse(
    (await cli(['session', 'export', mainBinding.sessionId, '--format', 'json'])).stdout,
  );
  assert.ok(Check(SessionHandoverSchema, exported));
  assert.deepEqual(exported.events, handover.events);
  for (const event of captured) {
    const saved = handover.events.find((item) => item.eventId === event.eventId);
    assert.equal(saved.git.afterCommitSha, event.git.afterCommitSha);
    assert.deepEqual(
      saved.diffs.map((diff) => diff.baselineCommitSha),
      event.diffs.map((diff) => diff.baselineCommitSha),
    );
    assert.deepEqual(
      saved.diffs.map((diff) => diff.text),
      event.diffs.map((diff) => diff.text),
    );
  }
  const prepared = buildSessionSynthesisInput(
    store.getSessionHandoverEvidence(context, mainBinding.sessionId),
  );
  assert.ok(Check(SessionSynthesisInputSchema, prepared.input));
  for (const event of captured) {
    const input = prepared.input.events.find((item) => item.id === event.eventId);
    assert.equal(input.afterCommitSha, event.git.afterCommitSha);
    assert.equal(input.diffBaselineCommitSha, event.diffs[0].baselineCommitSha);
  }
  const legacyInput = prepared.input.events.find((event) => event.id === legacy.eventId);
  assert.equal(legacyInput.diffBaselineCommitSha, null);
  assert.equal(legacyInput.afterCommitSha ?? null, null);
  const unbornInput = buildSessionSynthesisInput(
    store.getSessionHandoverEvidence(context, unbornBinding.sessionId),
  ).input;
  assert.ok(Check(SessionSynthesisInputSchema, unbornInput));
  assert.equal(unbornInput.events[0].afterCommitSha, null);
  assert.equal(unbornInput.events[0].diffBaselineCommitSha, null);
  assert.equal(unbornInput.events[0].captureIncomplete, true);
  mcp = startMcp();
  await mcp.initialize();
  const mcpPage = await mcp.tool('get_session_context', { id: mainBinding.sessionId, limit: 10 });
  assert.deepEqual(
    mcpPage.events.map((event) => event.eventId),
    expected.map((event) => event.eventId),
  );
  for (const event of expected) {
    const item = mcpPage.events.find((value) => value.eventId === event.eventId);
    assert.deepEqual(item.git, event.git);
    assert.deepEqual(
      item.diffs.map((diff) => diff.baselineCommitSha),
      event.diffs.map((diff) => diff.baselineCommitSha),
    );
  }
  const mcpRecap = await mcp.tool('get_session_recap', { id: mainBinding.sessionId });
  assert.deepEqual(mcpRecap.sources, recap.sources);
  assert.deepEqual(
    mcpRecap.steps.map((step) => step.eventId),
    expected.map((event) => event.eventId),
  );
  const preview = await mcp.tool('get_session_handover', { id: mainBinding.sessionId });
  assert.equal(preview.fullReportIncluded, false);
  assert.equal(preview.diffTextIncluded, false);
  assert.deepEqual(
    preview.events.map((event) => event.eventId),
    expected.map((event) => event.eventId),
  );
  for (const event of captured) {
    const item = preview.events.find((value) => value.eventId === event.eventId);
    assert.equal(item.afterCommitSha, event.git.afterCommitSha);
    assert.deepEqual(
      item.diffBaselines,
      event.diffs.map((diff) => ({ phase: diff.phase, baselineCommitSha: diff.baselineCommitSha })),
    );
  }
  const legacyPreview = preview.events.find((event) => event.eventId === legacy.eventId);
  assert.ok(!Object.hasOwn(legacyPreview, 'afterCommitSha'));
  assert.ok(!Object.hasOwn(legacyPreview, 'diffBaselines'));
  const unbornPage = await mcp.tool('get_session_context', {
    id: unbornBinding.sessionId,
    limit: 5,
  });
  assert.equal(unbornPage.events[0].eventId, unborn.eventId);
  assert.equal(unbornPage.events[0].git.afterCommitSha, null);
  assert.deepEqual(unbornPage.events[0].diffs, []);
  assert.equal(store.database.prepare('SELECT total_changes() AS count').get().count, beforeReads);
  assert.equal(providerCalls, 0);
  assert.equal(store.database.prepare('SELECT count(*) AS count FROM local_events').get().count, 6);
  assert.equal(
    store.database.prepare('SELECT count(*) AS count FROM local_memories').get().count,
    0,
  );
  await mcp.close();
  mcp = undefined;
  report = {
    status: 'passed',
    syntheticFixturesOnly: true,
    actualGit: true,
    actualCapturedCommands: 5,
    labeledLegacyMetadataEvents: 1,
    acceptedEvents: 6,
    providerCalls,
    fixedBeforeAfterBaseline: true,
    stagingOnlyComparison: true,
    commitAndResetHeadMovement: true,
    unavailableUnbornBaseline: true,
    immutableLegacyReplay: true,
    apiCliMcpAgreement: true,
    handoverAndSynthesisProvenance: true,
    checkedAt: new Date().toISOString(),
  };
} catch {
  console.error(
    `Git baseline acceptance failed during ${stage}; no private fixture payload was printed.`,
  );
  report = {
    status: 'failed',
    syntheticFixturesOnly: true,
    stage,
    checkedAt: new Date().toISOString(),
  };
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  for (const [child, state] of children) {
    try {
      if (!state.closed) await stop(child);
      safe(state.stdout);
      safe(state.stderr);
      if (state.failed) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await app.close();
  } catch {
    cleanupFailed = true;
  }
  if (!cleanupFailed) {
    const entry = lstatSync(fixture);
    const target = realpathSync(fixture);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      target !== fixture ||
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-git-baseline-')
    )
      throw new Error('Unsafe Git-baseline acceptance cleanup target.');
    rmSync(target, { recursive: true, force: true });
  } else {
    report.status = 'failed';
    report.stage = 'owned process cleanup';
    process.exitCode = 1;
  }
  safe(report);
  mkdirSync(join(root, '.memvora'), { recursive: true });
  writeFileSync(
    join(root, '.memvora', 'git-baseline-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(root, '.memvora', 'git-baseline-acceptance.json'),
    }),
  );
}
