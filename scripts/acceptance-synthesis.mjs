import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Check } from 'typebox/value';
import {
  SessionSynthesisHistorySchema,
  SessionSynthesisInputSchema,
  SessionSynthesisPreviewSchema,
  SessionSynthesisResponseSchema,
} from '../packages/contracts/dist/index.js';
import {
  LocalMemvora,
  runSessionSynthesisOnce,
  validateSessionSynthesisHistory,
  validateSessionSynthesisPreview,
  validateSessionSynthesisResponse,
} from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { createSessionSynthesizer } from '../packages/enrichment/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';

// Only labeled synthetic metadata, a disposable store and a loopback provider are used.
const root = resolve(import.meta.dirname, '..');
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-synthesis-acceptance-'));
const token = randomBytes(32).toString('hex');
const providerKey = randomBytes(32).toString('hex');
const inputSecret = 'synthetic-synthesis-input-private-value';
const outputSecret = 'synthetic-synthesis-output-private-value';
const foreignMarker = 'ForeignSynthesisFixtureMustRemainHidden';
const hostileText = '<script>globalThis.memvoraSynthesisFixtureMustRemainInert=true</script>';
const model = 'synthetic-synthesis-acceptance-model';
const store = new SqliteEvidenceStore(':memory:');
const service = new LocalMemvora(store);
const children = new Map();
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  const upper = name.toUpperCase();
  if (
    /^(MEMVORA_|AI_|GH_|GITHUB_|GIT_|DOTENV_|NPM_CONFIG_)/u.test(upper) ||
    ['NODE_OPTIONS', 'NODE_PATH', 'DATABASE_URL'].includes(upper)
  )
    delete environment[name];
}
Object.assign(environment, {
  MEMVORA_DATA_DIR: fixture,
  MEMVORA_LOCAL_TOKEN: token,
  MEMVORA_AI_ENABLED: 'false',
  MEMVORA_SESSION_SYNTHESIS_ENABLED: 'false',
  AI_API_KEY: '',
  AI_BASE_URL: '',
  AI_MODEL: '',
  NEXT_TELEMETRY_DISABLED: '1',
  NODE_OPTIONS: '--max-old-space-size=1536 --v8-pool-size=1',
  UV_THREADPOOL_SIZE: '2',
});
writeFileSync(join(fixture, 'local-token'), `${token}\n`, { mode: 0o600 });
writeFileSync(join(fixture, '.git'), 'gitdir: synthetic-boundary-not-used\n');
let app;
let mcp;
let api;
let web;
let providerCalls = 0;
let apiRequests = 0;
let providerFailure;
let session;
let eventIds;
let note;
let stage = 'fixture setup';
let report = { status: 'failed', syntheticFixturesOnly: true };

function safe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [token, providerKey, inputSecret, outputSecret, foreignMarker])
    assert.ok(!text.includes(secret), 'A private fixture value was exposed.');
}
function changes() {
  return store.database.prepare('SELECT total_changes() AS count').get().count;
}
async function readOnly(action) {
  const before = changes();
  const calls = providerCalls;
  const value = await action();
  assert.equal(
    changes(),
    before,
    'A read or exact replay changed persisted evidence or processing state.',
  );
  assert.equal(providerCalls, calls, 'A read or exact replay invoked the provider.');
  assert.equal(providerFailure, undefined, 'Synthetic provider contract failed.');
  return value;
}
async function responseText(response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  assert.ok(reader, 'HTTP response had no body.');
  const chunks = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error('HTTP response exceeded its fixture budget.');
    }
    chunks.push(chunk.value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  safe(text);
  return text;
}
async function json(
  origin,
  path,
  { body, expected = 200, authenticated = false, originHeader, schema } = {},
) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(originHeader === undefined ? {} : { origin: originHeader }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, 'Synthesis HTTP status violated its contract.');
  const value = JSON.parse(await responseText(response));
  if (schema) assert.ok(Check(schema, value), 'Synthesis HTTP response violated its schema.');
  if (origin === web) assert.equal(response.headers.get('cache-control'), 'no-store');
  return value;
}
async function page(path) {
  const response = await fetch(new URL(path, web), {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200);
  const text = await responseText(response);
  assert.ok(text.includes('AI interpretation'));
  assert.ok(
    !text.includes(hostileText),
    'Untrusted model text became an executable script element.',
  );
  return text;
}
async function waitClosed(state, timeoutMs) {
  if (state.closed) return true;
  let timer;
  try {
    return await Promise.race([
      state.done.then(() => true),
      new Promise((done) => {
        timer = setTimeout(() => done(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(child) {
  const state = children.get(child);
  if (!state) throw new Error('Refusing cleanup of an unowned synthesis process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitClosed(state, 1000)) return;
      throw new Error('Synthesis child cleanup could not be confirmed.');
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
          if (error?.code !== 'ESRCH') throw new Error('Synthesis process group cleanup failed.');
        }
        if (signal === 'SIGTERM' && (await waitClosed(state, 1000))) return;
      }
    }
    if (!(await waitClosed(state, 3000))) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw new Error('Synthesis child cleanup could not be confirmed; fixture retained.');
    }
  })();
  return state.stopping;
}
function start(args, { cwd = fixture, interactive = false } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
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
  children.set(child, state);
  return child;
}
async function cli(args, expected = 0) {
  const child = start([join(root, 'apps/cli/dist/index.js'), ...args]);
  const state = children.get(child);
  let timer;
  try {
    const result = await Promise.race([
      state.done,
      new Promise((_done, reject) => {
        timer = setTimeout(() => {
          void stop(child)
            .finally(() => reject(new Error('Synthesis CLI timed out.')))
            .catch(() => {});
        }, 20_000);
      }),
    ]);
    assert.equal(result.code, expected, 'Compiled synthesis CLI returned an unexpected exit.');
    assert.equal(result.signal, null);
    assert.equal(state.failed, false);
    safe(state.stdout);
    safe(state.stderr);
    return {
      value: expected === 0 ? JSON.parse(state.stdout) : null,
      stderr: state.stderr,
      stdout: state.stdout,
    };
  } finally {
    clearTimeout(timer);
    if (state.stopping) await state.stopping;
  }
}
function startMcp() {
  const child = start([join(root, 'apps/mcp/dist/index.js')], { interactive: true });
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
  child.on('error', () => fail(new Error('Synthesis MCP startup failed.')));
  child.once('close', () => {
    if (waiting.size) fail(new Error('Synthesis MCP exited before responding.'));
  });
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > 256 * 1024)
      return fail(new Error('MCP frame exceeded its budget.'));
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
          if (message.error) waiter.reject(new Error('Synthesis MCP protocol error.'));
          else waiter.resolve(message.result);
        }
      } catch {
        fail(new Error('Synthesis MCP stdout was not safe protocol JSON.'));
      }
    }
  });
  function call(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolveCall, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('Synthesis MCP request timed out.'));
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
        clientInfo: { name: 'memvora-synthetic-synthesis-acceptance', version: '1.0.0' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      const { tools } = await call('tools/list', {});
      assert.equal(tools.length, 14);
      for (const name of ['get_session_synthesis', 'get_session_synthesis_history']) {
        const tool = tools.find((item) => item.name === name);
        assert.ok(tool?.annotations?.readOnlyHint);
        assert.equal(tool.annotations.destructiveHint, false);
      }
    },
    async get(input, errorExpected = false) {
      const result = await call('tools/call', { name: 'get_session_synthesis', arguments: input });
      safe(result);
      if (errorExpected) {
        assert.equal(result.isError, true);
        return result;
      }
      assert.ok(!result.isError, 'Synthesis read-only tool failed.');
      assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 96 * 1024);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.readOnly, true);
      assert.ok(value.label.includes('unverified'));
      return value;
    },
    async history(input, errorExpected = false) {
      const result = await call('tools/call', {
        name: 'get_session_synthesis_history',
        arguments: input,
      });
      safe(result);
      if (errorExpected) {
        assert.equal(result.isError, true);
        return result;
      }
      assert.ok(!result.isError, 'Synthesis read-only history tool failed.');
      assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 96 * 1024);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.readOnly, true);
      assert.ok(value.label.includes('unverified'));
      const { readOnly: _readOnly, label: _label, maxBytes, evidenceNotice, ...history } = value;
      assert.equal(maxBytes, 96 * 1024);
      assert.equal(typeof evidenceNotice, 'string');
      return validateSessionSynthesisHistory(history, input.id);
    },
    async close() {
      child.stdin.end();
      assert.ok(await waitClosed(children.get(child), 5000), 'Synthesis MCP did not close on EOF.');
      const state = children.get(child);
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
async function listen(server) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function unusedPort() {
  const socket = createServer();
  const address = await listen(socket);
  await new Promise((done, reject) => socket.close((error) => (error ? reject(error) : done())));
  return new URL(address).port;
}
async function hostileHost(path) {
  return new Promise((done, reject) => {
    const request = httpRequest(
      new URL(path, web),
      { headers: { host: 'untrusted.invalid' }, signal: AbortSignal.timeout(10_000) },
      (response) => {
        response.resume();
        response.once('end', () => done(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end();
  });
}
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${providerKey}`);
    const chunks = [];
    let length = 0;
    request.setTimeout(5000, () => request.destroy());
    for await (const chunk of request) {
      length += chunk.length;
      assert.ok(length <= 256 * 1024);
      chunks.push(chunk);
    }
    const completion = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(completion.model, model);
    assert.equal(completion.stream, false);
    const input = JSON.parse(
      completion.messages.find((message) => message.role === 'user').content,
    );
    assert.ok(Check(SessionSynthesisInputSchema, input));
    safe(input);
    assert.equal(input.sessionId, session.id);
    assert.deepEqual(
      input.events.map((event) => event.id),
      eventIds,
    );
    assert.ok(input.notes.some((item) => item.id === note.id));
    providerCalls++;
    const analysis = {
      overview: {
        text: `Synthetic acceptance interpretation only. ${hostileText}\npassword=${outputSecret}\n${providerKey}`,
        sourceIds: eventIds,
      },
      hypotheses: [
        {
          text: 'Synthetic inference: compare the recorded failure and later exit; no causal fix is established.',
          sourceIds: [eventIds[0], note.id],
        },
      ],
      unresolvedQuestions: [
        {
          text: 'Synthetic question: was the later check equivalent to the first?',
          sourceIds: eventIds,
        },
      ],
      suggestedChecks: [
        {
          text: 'Synthetic suggestion only: repeat the check. This analysis has not run it.',
          sourceIds: [eventIds[1]],
        },
      ],
      uncertainty: [
        'Synthetic fixture: authored claims and passing exits do not verify a root cause.',
      ],
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }],
      }),
    );
  } catch {
    providerFailure = true;
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":"Synthetic provider contract failed."}');
  }
});

try {
  const providerOrigin = await listen(provider);
  const synthesis = createSessionSynthesizer({
    baseUrl: `${providerOrigin}/v1`,
    apiKey: providerKey,
    model,
    timeoutMs: 5000,
  });
  app = buildApp({ store, token, embeddedWorker: false, synthesis });
  app.addHook('onRequest', async () => {
    apiRequests++;
  });
  const context = service.context();
  const repository = service.createRepository({
    name: 'Synthetic synthesis acceptance repository',
  });
  session = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Synthetic synthesis fixture; no commands executed',
  });
  const events = Array.from({ length: 2 }, (_, index) => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: index + 1,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: {
      executable: 'synthetic-synthesis-fixture',
      args: ['metadata-not-executed'],
      shell: 'fixture_not_executed',
    },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: index ? 0 : 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      {
        stream: 'stdout',
        ordinal: 0,
        text: `Synthetic ${index ? 'later exit' : 'earlier failure'} metadata. password=${inputSecret}`,
      },
    ],
    diffs: [],
  }));
  eventIds = events.map((event) => event.eventId);
  service.ingest(events);
  note = store.createSessionNote(context, session.id, {
    id: randomUUID(),
    kind: 'decision',
    body: 'Synthetic author report: the cause is still unverified.',
    eventIds: [eventIds[0]],
  }).note;
  const other = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Synthetic separate investigation',
  });
  const foreign = {
    mode: 'local',
    user: { id: randomUUID(), name: 'Synthetic foreign owner' },
    workspace: { id: randomUUID(), name: 'Synthetic foreign workspace', generation: 1 },
  };
  store.database
    .prepare(
      "INSERT INTO local_workspaces(id,owner_user_id,name,generation,status,created_at) VALUES(?,?,?,1,'active',?)",
    )
    .run(foreign.workspace.id, foreign.user.id, foreign.workspace.name, '2026-10-21T10:00:00.000Z');
  const foreignRepository = store.createRepository(foreign, { name: foreignMarker });
  const foreignSession = store.createSession(foreign, { repositoryId: foreignRepository.id });
  api = await app.listen({ host: '127.0.0.1', port: 0 });
  environment.MEMVORA_API_URL = api;
  const webPort = await unusedPort();
  web = `http://127.0.0.1:${webPort}`;
  const website = start(
    [
      join(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    { cwd: join(root, 'apps/web') },
  );
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    assert.equal(
      children.get(website).closed,
      false,
      'Compiled synthesis website exited before startup.',
    );
    try {
      const response = await fetch(`${web}/api/status`, {
        redirect: 'error',
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* bounded readiness retry */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, 'Compiled synthesis website did not become ready.');
  const apiPath = `/v1/sessions/${session.id}/synthesis`;
  const bffPath = `/api/sessions/${session.id}/synthesis`;
  const pagePath = `/sessions/${session.id}/synthesis`;
  async function history(expectedIds, expectedStatuses, stale = false) {
    return readOnly(async () => {
      const value = validateSessionSynthesisHistory(
        await json(api, `${apiPath}/history`, {
          authenticated: true,
          schema: SessionSynthesisHistorySchema,
        }),
        session.id,
      );
      assert.equal(value.repositoryId, repository.id);
      assert.equal(value.retainedCount, expectedIds.length);
      assert.equal(value.requestLimit, 32);
      assert.equal(value.order, 'newest_requested_first');
      assert.equal(value.analysisIncluded, false);
      assert.equal(value.sourcesIncluded, false);
      assert.deepEqual(
        value.items.map((item) => item.id),
        expectedIds,
      );
      assert.deepEqual(
        value.items.map((item) => item.status),
        expectedStatuses,
      );
      for (const item of value.items) {
        assert.equal(item.stale, stale);
        assert.ok(!('analysis' in item));
        assert.ok(!('sources' in item));
        assert.ok(!('input' in item));
        const detail = validateSessionSynthesisResponse(
          await json(api, `${apiPath}?${new URLSearchParams({ requestId: item.id })}`, {
            authenticated: true,
            schema: SessionSynthesisResponseSchema,
          }),
          session.id,
          item.id,
        ).request;
        const { analysis: _analysis, sources: _sources, ...metadata } = detail;
        assert.deepEqual(item, metadata, 'History metadata differs from the selected original.');
      }
      assert.deepEqual(
        await json(web, `${bffPath}/history`, { schema: SessionSynthesisHistorySchema }),
        value,
      );
      assert.deepEqual((await cli(['session', 'synthesis-history', session.id])).value, value);
      assert.deepEqual(await mcp.history({ id: session.id }), value);
      return value;
    });
  }
  stage = 'read-only preview and mutation boundaries';
  const preview = await readOnly(async () => {
    const value = validateSessionSynthesisPreview(
      await json(api, `${apiPath}/preview`, {
        authenticated: true,
        schema: SessionSynthesisPreviewSchema,
      }),
      session.id,
    );
    assert.equal(value.availability, 'available');
    assert.equal(value.configuration.model, model);
    assert.deepEqual(
      await json(web, `${bffPath}/preview`, { schema: SessionSynthesisPreviewSchema }),
      value,
    );
    assert.equal(
      (await json(web, bffPath, { schema: SessionSynthesisResponseSchema })).request,
      null,
    );
    const html = await page(pagePath);
    assert.ok(html.includes(model));
    assert.ok(html.includes(value.inputHash));
    assert.ok(html.includes('No interpretation requested'));
    assert.deepEqual((await cli(['session', 'synthesis-preview', session.id])).value, value);
    assert.equal((await cli(['session', 'synthesis', session.id])).value.request, null);
    return value;
  });
  mcp = startMcp();
  await readOnly(() => mcp.initialize());
  await readOnly(async () => {
    assert.equal((await mcp.get({ id: session.id })).request, null);
    const before = apiRequests;
    await mcp.get({ id: session.id, repositoryId: repository.id }, true);
    assert.equal(apiRequests, before, 'Unknown MCP selector reached the API.');
    await mcp.get({ id: foreignSession.id }, true);
    const beforeHistory = apiRequests;
    await mcp.history({ id: session.id, requestId: randomUUID() }, true);
    assert.equal(apiRequests, beforeHistory, 'Unknown history selector reached the API.');
    await mcp.history({ id: foreignSession.id }, true);
  });
  await history([], []);
  const input = { requestId: randomUUID(), expectedInputHash: preview.inputHash };
  await readOnly(async () => {
    await json(api, apiPath, { expected: 401 });
    await json(api, `${apiPath}/history`, { expected: 401 });
    await json(web, bffPath, { body: input, expected: 403 });
    await json(web, bffPath, {
      body: input,
      originHeader: 'https://untrusted.invalid',
      expected: 403,
    });
    await json(web, bffPath, { body: { ...input, extra: true }, originHeader: web, expected: 400 });
    await json(web, `${bffPath}?extra=1`, { expected: 400 });
    await json(web, `${bffPath}?requestId=${input.requestId}&requestId=${input.requestId}`, {
      expected: 400,
    });
    await json(web, `${bffPath}/preview?extra=1`, { expected: 400 });
    await json(api, `${apiPath}/history?limit=1`, { authenticated: true, expected: 400 });
    await json(web, `${bffPath}/history?limit=1`, { expected: 400 });
    await json(api, `/v1/sessions/${foreignSession.id}/synthesis/history`, {
      authenticated: true,
      expected: 404,
    });
    await json(web, `/api/sessions/${foreignSession.id}/synthesis/history`, { expected: 404 });
    await json(web, '/api/sessions/not-a-uuid/synthesis', { expected: 400 });
    assert.equal(await hostileHost(bffPath), 403);
    assert.equal(await hostileHost(`${bffPath}/history`), 403);
  });
  stage = 'explicit website request, exact replay and one worker attempt';
  const queued = validateSessionSynthesisResponse(
    await json(web, bffPath, {
      body: input,
      originHeader: web,
      expected: 202,
      schema: SessionSynthesisResponseSchema,
    }),
    session.id,
    input.requestId,
  );
  assert.equal(queued.request.status, 'queued');
  assert.equal(queued.request.analysis, null);
  assert.equal(providerCalls, 0);
  await readOnly(async () => {
    assert.deepEqual(
      await json(web, bffPath, {
        body: input,
        originHeader: web,
        schema: SessionSynthesisResponseSchema,
      }),
      queued,
    );
    assert.deepEqual(
      (await mcp.get({ id: session.id, requestId: input.requestId })).request,
      queued.request,
    );
    assert.deepEqual(
      (await cli(['session', 'synthesis', session.id, '--request-id', input.requestId])).value,
      queued,
    );
    await json(web, bffPath, {
      body: { ...input, expectedInputHash: 'f'.repeat(64) },
      originHeader: web,
      expected: 409,
    });
    await json(web, `/api/sessions/${other.id}/synthesis?requestId=${input.requestId}`, {
      expected: 404,
    });
  });
  assert.equal(await runSessionSynthesisOnce(store, synthesis), true);
  assert.equal(providerCalls, 1);
  assert.equal(providerFailure, undefined);
  assert.equal(await runSessionSynthesisOnce(store, synthesis), false);
  assert.equal(providerCalls, 1);
  const readyResult = await readOnly(async () => {
    const value = validateSessionSynthesisResponse(
      await json(web, `${bffPath}?requestId=${input.requestId}`, {
        schema: SessionSynthesisResponseSchema,
      }),
      session.id,
      input.requestId,
    );
    assert.equal(value.request.status, 'ready');
    assert.equal(value.request.attempts, 1);
    assert.equal(value.request.stale, false);
    assert.deepEqual(
      value.request.sources.map((source) => source.id),
      [...eventIds, note.id],
    );
    assert.ok(value.request.analysis.overview.text.includes(hostileText));
    const html = await page(`${pagePath}?requestId=${input.requestId}`);
    assert.ok(
      html.includes(
        '&lt;script&gt;globalThis.memvoraSynthesisFixtureMustRemainInert=true&lt;/script&gt;',
      ),
    );
    assert.ok(html.includes('Request ready'));
    assert.ok(html.includes('unverified'));
    assert.deepEqual(
      (await mcp.get({ id: session.id, requestId: input.requestId })).request,
      value.request,
    );
    assert.deepEqual(
      (await cli(['session', 'synthesis', session.id, '--request-id', input.requestId])).value,
      value,
    );
    assert.deepEqual(
      await json(web, bffPath, {
        body: input,
        originHeader: web,
        schema: SessionSynthesisResponseSchema,
      }),
      value,
    );
    return value;
  });
  stage = 'explicit compiled CLI request and read-only MCP';
  const cliInput = { requestId: randomUUID(), expectedInputHash: preview.inputHash };
  const cliArgs = [
    'session',
    'synthesize',
    session.id,
    '--input-hash',
    cliInput.expectedInputHash,
    '--request-id',
    cliInput.requestId,
  ];
  const cliCreated = await cli(cliArgs);
  validateSessionSynthesisResponse(cliCreated.value, session.id, cliInput.requestId);
  assert.equal(cliCreated.value.request.status, 'queued');
  assert.ok(cliCreated.stderr.includes(cliInput.requestId));
  assert.ok(cliCreated.stderr.includes(cliInput.expectedInputHash));
  assert.equal(providerCalls, 1);
  await readOnly(async () => {
    assert.deepEqual((await cli(cliArgs)).value, cliCreated.value);
    assert.deepEqual((await mcp.get({ id: session.id })).request, cliCreated.value.request);
  });
  assert.equal(await runSessionSynthesisOnce(store, synthesis), true);
  assert.equal(providerCalls, 2);
  assert.equal(await runSessionSynthesisOnce(store, synthesis), false);
  assert.equal(providerCalls, 2);
  await readOnly(async () => {
    const value = (
      await cli(['session', 'synthesis', session.id, '--request-id', cliInput.requestId])
    ).value;
    assert.equal(value.request.status, 'ready');
    assert.equal(value.request.id, cliInput.requestId);
    assert.deepEqual(
      (await mcp.get({ id: session.id, requestId: cliInput.requestId })).request,
      value.request,
    );
    await mcp.get({ id: other.id, requestId: cliInput.requestId }, true);
  });
  stage = 'retained history discovers earlier ready versions after a later failure';
  await history([cliInput.requestId, input.requestId], ['ready', 'ready']);
  const failedInput = { requestId: randomUUID(), expectedInputHash: preview.inputHash };
  await json(web, bffPath, {
    body: failedInput,
    originHeader: web,
    expected: 202,
    schema: SessionSynthesisResponseSchema,
  });
  const failedJob = store.claimSessionSynthesis(synthesis.configuration);
  assert.ok(failedJob, 'The explicit synthetic failure request was not claimable.');
  assert.equal(failedJob.id, failedInput.requestId);
  store.failSessionSynthesis(failedJob);
  assert.equal(providerCalls, 2, 'The manual failure fixture unexpectedly invoked a provider.');
  const retainedIds = [failedInput.requestId, cliInput.requestId, input.requestId];
  const retainedStatuses = ['failed', 'ready', 'ready'];
  const retained = await history(retainedIds, retainedStatuses);
  assert.equal(retained.items[0].failureCode, 'PROVIDER_FAILED');
  await readOnly(async () => {
    const latest = await page(pagePath);
    assert.ok(latest.includes('Retained interpretation requests'));
    assert.ok(latest.includes('Request failed'));
    assert.ok(
      latest.includes(input.requestId),
      'The older ready request disappeared from history.',
    );
    const earlier = await page(
      `${pagePath}?${new URLSearchParams({ requestId: input.requestId })}`,
    );
    assert.ok(earlier.includes('Request ready'));
    assert.ok(earlier.includes('Original request ID'));
    assert.ok(earlier.includes(input.requestId));
    assert.ok(earlier.includes(failedInput.requestId));
    const replay = await json(web, bffPath, {
      body: failedInput,
      originHeader: web,
      schema: SessionSynthesisResponseSchema,
    });
    assert.equal(replay.request.id, failedInput.requestId);
    assert.equal(replay.request.status, 'failed');
    const otherHistory = await json(web, `/api/sessions/${other.id}/synthesis/history`, {
      schema: SessionSynthesisHistorySchema,
    });
    assert.deepEqual(validateSessionSynthesisHistory(otherHistory, other.id).items, []);
  });
  stage = 'stale evidence, immutable replay and deletion fences';
  store.createSessionNote(context, session.id, {
    id: randomUUID(),
    kind: 'note',
    body: 'Synthetic later update makes the earlier input stale.',
    eventIds: [],
  });
  await readOnly(async () => {
    const stale = await json(web, `${bffPath}?requestId=${input.requestId}`, {
      schema: SessionSynthesisResponseSchema,
    });
    assert.equal(stale.request.stale, true);
    assert.equal(stale.request.inputHash, readyResult.request.inputHash);
    assert.deepEqual(stale.request.analysis, readyResult.request.analysis);
    assert.equal(
      (await mcp.get({ id: session.id, requestId: input.requestId })).request.stale,
      true,
    );
    assert.ok(
      (await page(`${pagePath}?requestId=${input.requestId}`)).includes('Stale interpretation'),
    );
    await json(web, bffPath, {
      body: { requestId: randomUUID(), expectedInputHash: preview.inputHash },
      originHeader: web,
      expected: 409,
    });
    assert.equal(
      (
        await json(web, bffPath, {
          body: input,
          originHeader: web,
          schema: SessionSynthesisResponseSchema,
        })
      ).request.stale,
      true,
    );
  });
  await history(retainedIds, retainedStatuses, true);
  store.deleteSession(context, session.id);
  await readOnly(async () => {
    await json(api, apiPath, { authenticated: true, expected: 404 });
    await json(api, `${apiPath}/history`, { authenticated: true, expected: 404 });
    await json(web, `${bffPath}?requestId=${input.requestId}`, { expected: 404 });
    await json(web, `${bffPath}/preview`, { expected: 404 });
    await json(web, `${bffPath}/history`, { expected: 404 });
    await mcp.get({ id: session.id, requestId: input.requestId }, true);
    await mcp.history({ id: session.id }, true);
    const denied = await cli(
      ['session', 'synthesis', session.id, '--request-id', input.requestId],
      1,
    );
    assert.equal(denied.stdout, '');
    const deniedHistory = await cli(['session', 'synthesis-history', session.id], 1);
    assert.equal(deniedHistory.stdout, '');
  });
  assert.equal(await runSessionSynthesisOnce(store, synthesis), false);
  assert.equal(providerCalls, 2);
  await mcp.close();
  mcp = undefined;
  report = {
    status: 'passed',
    syntheticFixturesOnly: true,
    fixtureCommandsExecuted: false,
    syntheticLoopbackProvider: true,
    remoteProvidersCalled: false,
    providerCalls,
    apiRequests,
    compiledWebsite: true,
    compiledCli: true,
    mcpStdio: true,
    tools: 14,
    retainedHistoryVersions: 3,
    historyDiscovery: 'passed',
    failedRequestFixture: 'manually failed without a provider call',
    readOnlyGates: 'passed',
    requestIds: [input.requestId, cliInput.requestId, failedInput.requestId],
    sessionId: session.id,
    checkedAt: new Date().toISOString(),
  };
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown synthesis acceptance failure.';
  for (const secret of [token, providerKey, inputSecret, outputSecret, foreignMarker])
    message = message.replaceAll(secret, '[redacted fixture]');
  console.error(`Synthesis acceptance failed during ${stage}: ${message.slice(0, 1200)}`);
  report = {
    status: 'failed',
    syntheticFixturesOnly: true,
    stage,
    providerCalls,
    checkedAt: new Date().toISOString(),
  };
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  for (const [child, state] of children) {
    if (!state.closed) {
      try {
        await stop(child);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      safe(state.stdout);
      safe(state.stderr);
      assert.equal(state.failed, false);
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    if (app) await app.close();
    else store.close();
  } catch {
    cleanupFailed = true;
  }
  provider.closeAllConnections();
  if (provider.listening) await new Promise((done) => provider.close(() => done()));
  if (!cleanupFailed) {
    const entry = lstatSync(fixture);
    const target = realpathSync(fixture);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      target !== fixture ||
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-synthesis-acceptance-')
    )
      throw new Error('Unsafe synthesis acceptance cleanup target.');
    rmSync(target, { recursive: true, force: true });
  } else {
    report.status = 'failed';
    report.stage = 'owned process cleanup';
    process.exitCode = 1;
  }
  safe(report);
  mkdirSync(join(root, '.memvora'), { recursive: true });
  writeFileSync(
    join(root, '.memvora', 'synthesis-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      status: report.status,
      providerCalls,
      report: join(root, '.memvora', 'synthesis-acceptance.json'),
    }),
  );
}
