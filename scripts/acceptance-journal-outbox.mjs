import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Check } from 'typebox/value';
import {
  RecallAnswerSchema,
  SessionNoteResponseSchema,
  SessionNotesPageSchema,
} from '../packages/contracts/dist/index.js';
import {
  LocalMemvora,
  prepareSessionNote as canonicalNote,
  sessionNoteCitation,
} from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';

// Disposable synthetic metadata only: no captured command, remote provider or owner store is used.
const root = resolve(import.meta.dirname, '..');
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-journal-outbox-'));
const captureRoot = join(fixture, 'synthetic-bound-repository');
const privateDirectory = join(captureRoot, '.memvora');
const configurationPath = join(privateDirectory, 'config.json');
const outboxPath = join(privateDirectory, 'journal-outbox.sqlite');
const emptyRoot = join(fixture, 'empty-inspection');
const corruptRoot = join(fixture, 'corrupt-binding-inspection');
const invalidRoot = join(fixture, 'invalid-before-queue');
const token = randomBytes(32).toString('hex');
const inputSecret = 'synthetic-journal-outbox-private-password';
const bodyMarker = 'SyntheticPrivateJournalBody';
const children = new Map();
const posts = [];
const lostResponseIds = new Set();
const unsupportedAckIds = new Set();
const store = new SqliteEvidenceStore(':memory:');
const service = new LocalMemvora(store);
let providerCalls = 0;
const app = buildApp({
  store,
  token,
  embeddedWorker: false,
  enricher: async () => {
    providerCalls++;
    throw new Error('A read must not activate the synthetic provider guard.');
  },
});
let apiOrigin;
let proxyOrigin;
let guardOrigin;
let proxyRequests = 0;
let apiRequests = 0;
let guardRequests = 0;
let wrongPrincipal = false;
let proxyFailure = false;
let mcp;
let stage = 'setup';
let report = { status: 'failed', syntheticFixturesOnly: true };

const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  const upper = key.toUpperCase();
  if (
    /^(MEMVORA_|AI_|GH_|GITHUB_|GIT_|DOTENV_|NPM_CONFIG_)/u.test(upper) ||
    ['NODE_PATH', 'NODE_OPTIONS', 'DATABASE_URL'].includes(upper)
  )
    delete environment[key];
}
Object.assign(environment, {
  MEMVORA_DATA_DIR: join(fixture, 'missing-credential-directory'),
  MEMVORA_AI_ENABLED: 'false',
  MEMVORA_SESSION_SYNTHESIS_ENABLED: 'false',
  NODE_OPTIONS: '--max-old-space-size=1536 --v8-pool-size=1',
  UV_THREADPOOL_SIZE: '2',
});

function safe(value, metadataOnly = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [token, inputSecret])
    assert.ok(!text.includes(secret), 'A private fixture value was exposed.');
  if (metadataOnly) assert.ok(!text.includes(bodyMarker), 'Journal text escaped a metadata view.');
}
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function serverChanges() {
  return store.database.prepare('SELECT total_changes() AS count').get().count;
}
function serverNotes() {
  return store.database.prepare('SELECT count(*) AS count FROM local_session_notes').get().count;
}
function writeBinding(repositoryId, sessionId, apiUrl = proxyOrigin, directory = captureRoot) {
  mkdirSync(join(directory, '.memvora'), { recursive: true });
  const bytes = `${JSON.stringify({ schemaVersion: 1, repositoryId, sessionId, apiUrl }, null, 2)}\n`;
  writeFileSync(join(directory, '.memvora', 'config.json'), bytes);
  return bytes;
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
async function closeServer(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((done) => server.close(() => done()));
}
async function requestBody(request) {
  const chunks = [];
  let bytes = 0;
  request.setTimeout(5000, () => request.destroy());
  for await (const chunk of request) {
    bytes += chunk.length;
    assert.ok(bytes <= 128 * 1024, 'A synthetic request exceeded its budget.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function responseBody(response) {
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
      throw new Error('A synthetic response exceeded its budget.');
    }
    chunks.push(chunk.value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  safe(value);
  return value;
}
function send(response, status, value) {
  safe(value);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
const proxy = createServer(async (request, response) => {
  try {
    proxyRequests++;
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.ok(['GET', 'POST'].includes(request.method));
    assert.ok(request.url.startsWith('/v1/'));
    const target = new URL(request.url, apiOrigin);
    assert.equal(target.origin, apiOrigin);
    const body = request.method === 'POST' ? await requestBody(request) : undefined;
    let input;
    if (request.method === 'POST' && /^\/v1\/sessions\/[^/]+\/notes$/u.test(target.pathname)) {
      input = JSON.parse(body.toString('utf8'));
      safe(input);
      posts.push({ id: input.id, path: target.pathname, digest: hash(body) });
    }
    const upstream = await fetch(target, {
      method: request.method,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    });
    const value = await responseBody(upstream);
    if (target.pathname === '/v1/me' && upstream.ok && wrongPrincipal) value.user.id = randomUUID();
    if (input && upstream.ok) {
      assert.ok(Check(SessionNoteResponseSchema, value));
      assert.equal(value.note.id, input.id);
      if (lostResponseIds.delete(input.id)) {
        send(response, 503, {
          error: { message: 'Synthetic response intentionally lost after commit.' },
        });
        return;
      }
      if (unsupportedAckIds.delete(input.id)) value.note.author.id = randomUUID();
    }
    send(response, upstream.status, value);
  } catch {
    proxyFailure = true;
    if (!response.headersSent && !response.destroyed)
      send(response, 503, { error: { message: 'Synthetic journal proxy contract failed.' } });
    else response.destroy();
  }
});
const guard = createServer((request, response) => {
  guardRequests++;
  request.resume();
  send(response, 503, { error: { message: 'The wrong-origin fixture must never be contacted.' } });
});

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
  if (!state) throw new Error('Refusing to stop an unowned journal process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitClosed(state, 1000)) return;
      throw new Error('Journal process cleanup could not be confirmed.');
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
          if (error?.code !== 'ESRCH') throw new Error('Journal process group cleanup failed.');
        }
        if (signal === 'SIGTERM' && (await waitClosed(state, 1000))) return;
      }
    }
    if (!(await waitClosed(state, 3000))) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw new Error('Journal process cleanup could not be confirmed; fixture retained.');
    }
  })();
  return state.stopping;
}
function start(args, { cwd = captureRoot, online = false, interactive = false } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...environment,
      ...(online ? { MEMVORA_LOCAL_TOKEN: token, MEMVORA_API_URL: proxyOrigin } : {}),
    },
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
async function cli(args, { expected = 0, metadataOnly = true, ...options } = {}) {
  const child = start([join(root, 'apps/cli/dist/index.js'), ...args], options);
  const state = children.get(child);
  let timer;
  try {
    const result = await Promise.race([
      state.done,
      new Promise((_done, reject) => {
        timer = setTimeout(() => {
          void stop(child)
            .finally(() => reject(new Error('Journal CLI timed out.')))
            .catch(() => {});
        }, 15_000);
      }),
    ]);
    assert.equal(result.code, expected, 'The compiled journal CLI returned an unexpected exit.');
    assert.equal(result.signal, null);
    assert.equal(state.failed, false);
    safe(state.stdout, metadataOnly);
    safe(state.stderr, true);
    if (expected !== 0) {
      assert.equal(state.stdout, '');
      return null;
    }
    return JSON.parse(state.stdout);
  } finally {
    clearTimeout(timer);
    if (state.stopping) await state.stopping;
  }
}
function startMcp() {
  const child = start([join(root, 'apps/mcp/dist/index.js')], { online: true, interactive: true });
  const waiting = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let nextId = 0;
  let failure;
  const fail = () => {
    failure ??= new Error('Journal MCP protocol failed.');
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
          if (message.error) waiter.reject(new Error('Journal MCP request failed.'));
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
        reject(new Error('Journal MCP timed out.'));
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
        clientInfo: { name: 'memvora-synthetic-journal-outbox-acceptance', version: '1.0.0' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      const { tools } = await call('tools/list', {});
      assert.equal(tools.length, 14);
      assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    },
    async tool(name, input) {
      const result = await call('tools/call', { name, arguments: input });
      safe(result);
      assert.ok(!result.isError, 'Read-only journal MCP retrieval failed.');
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
async function list({ directory = captureRoot, state = 'all', limit = 50, after } = {}) {
  const args = [
    'journal',
    'list',
    '--directory',
    directory,
    '--state',
    state,
    '--limit',
    String(limit),
  ];
  if (after !== undefined) args.push('--after', String(after));
  const result = await cli(args);
  assert.equal(result.source, 'local_journal_outbox');
  assert.equal(result.readOnly, true);
  assert.equal(result.page.returnedItems, result.items.length);
  assert.equal(result.page.limit, limit);
  assert.equal(result.page.consistency, 'live');
  for (const item of result.items) {
    assert.ok(!('body' in item) && !('eventIds' in item) && !('peer' in item));
    assert.ok(Number.isSafeInteger(item.localRowId) && item.localRowId > 0);
    assert.ok(/^[a-f0-9]{64}$/u.test(item.digest));
  }
  return result;
}
async function queue(input, sessionId) {
  const args = [
    'session',
    'note',
    ...(sessionId ? [sessionId] : []),
    '--queue',
    '--text',
    input.body,
    '--kind',
    input.kind,
    '--note-id',
    input.id,
  ];
  for (const eventId of input.eventIds) args.push('--event', eventId);
  const result = await cli(args);
  assert.equal(result.mode, 'queued_locally');
  assert.equal(result.serverContacted, false);
  assert.equal(result.item.noteId, input.id);
  assert.ok(/^[a-f0-9]{64}$/u.test(result.item.digest));
  assert.equal(result.item.eventCount, input.eventIds.length);
  assert.equal(result.item.state, 'pending');
  assert.equal(result.item.peerPinned, false);
  return result.item;
}
async function retry(id, { expected = 0, online = true, prefix = [] } = {}) {
  return cli([...prefix, 'journal', 'retry', '--note', id], { expected, online });
}

try {
  for (const directory of [captureRoot, emptyRoot, corruptRoot, invalidRoot])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(fixture, '.git'), 'gitdir: synthetic-boundary-not-used\n', { flag: 'wx' });
  mkdirSync(join(corruptRoot, '.memvora'));
  writeFileSync(join(corruptRoot, '.memvora', 'config.json'), '{invalid synthetic binding');
  app.addHook('onRequest', async () => {
    apiRequests++;
  });
  apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  proxyOrigin = await listen(proxy);
  guardOrigin = await listen(guard);
  const context = service.context();
  const repository = service.createRepository({ name: 'Synthetic queued journal repository' });
  const otherRepository = service.createRepository({
    name: 'Synthetic separate journal repository',
  });
  const session = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Synthetic offline journal investigation',
  });
  const nextSession = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Synthetic newer bound investigation',
  });
  const deletedSession = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Synthetic later-deleted investigation',
  });
  const otherSession = store.createSession(context, { repositoryId: otherRepository.id });
  const events = [1, 2].map((sequence) => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: {
      executable: 'synthetic-journal-outbox-fixture',
      args: [],
      shell: 'metadata_not_executed',
    },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: sequence === 1 ? 1 : 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      { stream: 'stdout', ordinal: 0, text: 'Synthetic journal citation metadata; not executed.' },
    ],
    diffs: [],
  }));
  service.ingest(events);
  const eventIds = events.map((event) => event.eventId);
  writeBinding(repository.id, session.id);
  writeBinding(repository.id, session.id, proxyOrigin, invalidRoot);

  stage = 'offline inspection and invalid selectors create no outbox';
  const offlineChanges = serverChanges();
  const corruptBindingHash = hash(readFileSync(join(corruptRoot, '.memvora', 'config.json')));
  for (const directory of [emptyRoot, corruptRoot]) {
    const before = readdirSync(directory).sort();
    const result = await list({ directory });
    assert.equal(result.exists, false);
    assert.deepEqual(result.totals, { all: 0, pending: 0, synced: 0 });
    assert.deepEqual(readdirSync(directory).sort(), before);
    assert.ok(!existsSync(join(directory, '.memvora', 'journal-outbox.sqlite')));
  }
  assert.equal(
    hash(readFileSync(join(corruptRoot, '.memvora', 'config.json'))),
    corruptBindingHash,
  );
  for (const suffix of [
    ['--limit', '0'],
    ['--after', 'not-a-row'],
    ['--state', 'unknown'],
  ])
    await cli(['journal', 'list', '--directory', emptyRoot, ...suffix], { expected: 1 });
  await cli(['journal', 'retry', '--note', 'not-a-uuid'], { cwd: invalidRoot, expected: 1 });
  await cli(
    ['session', 'note', '--queue', '--text', `${bodyMarker} invalid`, '--kind', 'unknown'],
    { cwd: invalidRoot, expected: 1 },
  );
  await cli(['session', 'note', '--queue', '--text', `${bodyMarker} unbound`], {
    cwd: emptyRoot,
    expected: 1,
  });
  assert.ok(!existsSync(join(invalidRoot, '.memvora', 'journal-outbox.sqlite')));
  assert.ok(!existsSync(join(emptyRoot, '.memvora')));
  assert.equal(proxyRequests, 0);
  assert.equal(apiRequests, 0);
  assert.equal(serverChanges(), offlineChanges);

  stage = 'offline queue survives CLI restarts with canonical redaction and stable identity';
  const first = {
    id: randomUUID(),
    kind: 'decision',
    body: `  ${bodyMarker} OfflineJournalRecallMarker\r\npassword=${inputSecret}\u202e  `,
    eventIds: [...eventIds].reverse(),
  };
  const queued = await queue(first);
  assert.equal(queued.repositoryId, repository.id);
  assert.equal(queued.sessionId, session.id);
  assert.equal(queued.apiOrigin, proxyOrigin);
  const same = await queue({ ...first, eventIds });
  assert.equal(same.localRowId, queued.localRowId);
  assert.equal(same.digest, queued.digest);
  const originalOutbox = hash(readFileSync(outboxPath));
  await cli(
    [
      'session',
      'note',
      '--queue',
      '--text',
      `${bodyMarker} different immutable body`,
      '--kind',
      first.kind,
      '--note-id',
      first.id,
    ],
    { expected: 1 },
  );
  await cli(
    ['session', 'note', nextSession.id, '--queue', '--text', `${bodyMarker} wrong bound session`],
    { expected: 1 },
  );
  writeBinding(repository.id, undefined);
  await cli(['session', 'note', '--queue', '--text', `${bodyMarker} no current session`], {
    expected: 1,
  });
  writeBinding(repository.id, session.id);
  assert.equal(hash(readFileSync(outboxPath)), originalOutbox);
  const pendingFirst = await list();
  assert.deepEqual(pendingFirst.totals, { all: 1, pending: 1, synced: 0 });
  assert.equal(pendingFirst.items[0].noteId, first.id);
  assert.equal(pendingFirst.items[0].peerPinned, false);
  assert.equal(hash(readFileSync(outboxPath)), originalOutbox);
  assert.ok(!readFileSync(outboxPath).includes(Buffer.from(inputSecret)));
  assert.equal(proxyRequests, 0);
  assert.equal(apiRequests, 0);
  assert.equal(serverChanges(), offlineChanges);

  const deleted = {
    id: randomUUID(),
    kind: 'note',
    body: `${bodyMarker} retained after parent deletion.`,
    eventIds: [],
  };
  writeBinding(repository.id, deletedSession.id);
  await queue(deleted, deletedSession.id);
  writeBinding(repository.id, session.id);
  const unsupported = {
    id: randomUUID(),
    kind: 'note',
    body: `${bodyMarker} unsupported ACK remains pending.`,
    eventIds: [eventIds[0]],
  };
  const conflict = {
    id: randomUUID(),
    kind: 'resolution',
    body: `${bodyMarker} queued claim conflicts with the server.`,
    eventIds: [],
  };
  const healthy = {
    id: randomUUID(),
    kind: 'note',
    body: `${bodyMarker} independent selected note.`,
    eventIds: [eventIds[1]],
  };
  for (const input of [unsupported, conflict, healthy]) await queue(input);
  assert.equal(proxyRequests, 0);
  assert.equal(serverChanges(), offlineChanges);
  store.deleteSession(context, deletedSession.id);
  const existingConflict = store.createSessionNote(context, session.id, {
    ...conflict,
    body: `${bodyMarker} original server claim remains immutable.`,
  }).note;
  assert.equal(serverNotes(), 1);

  stage = 'commit then lost response retains exact note identity and pins the authenticated peer';
  lostResponseIds.add(first.id);
  await retry(first.id, { expected: 1 });
  assert.equal(proxyFailure, false);
  assert.equal(posts.filter((post) => post.id === first.id).length, 1);
  const persistedFirst = store.getSessionNote(context, first.id);
  assert.equal(persistedFirst.body, canonicalNote(first).input.body);
  assert.deepEqual(
    persistedFirst.sources.map((source) => source.id),
    [...eventIds].sort(),
  );
  assert.equal(persistedFirst.author.id, context.user.id);
  assert.equal(serverNotes(), 2);
  const afterLoss = (await list()).items.find((item) => item.noteId === first.id);
  assert.equal(afterLoss.state, 'pending');
  assert.equal(afterLoss.peerPinned, true);
  assert.equal(afterLoss.digest, queued.digest);

  stage = 'wrong origin, repository and authenticated principal cannot send a queued body';
  const beforeWrongOrigin = proxyRequests;
  await retry(first.id, { expected: 1, prefix: ['--api-url', guardOrigin] });
  assert.equal(proxyRequests, beforeWrongOrigin);
  assert.equal(guardRequests, 0);
  writeBinding(otherRepository.id, otherSession.id);
  await retry(first.id, { expected: 1 });
  assert.equal(proxyRequests, beforeWrongOrigin);
  writeBinding(repository.id, session.id);
  wrongPrincipal = true;
  const beforeWrongPrincipal = posts.length;
  await retry(first.id, { expected: 1 });
  assert.equal(posts.length, beforeWrongPrincipal);
  wrongPrincipal = false;
  assert.equal(store.getSessionNote(context, first.id).body, persistedFirst.body);

  stage =
    'selected old-session retry confirms one server note and acknowledged retry needs no credential';
  const finalBinding = writeBinding(repository.id, nextSession.id);
  const confirmed = await retry(first.id);
  assert.equal(confirmed.mode, 'confirmed');
  assert.equal(confirmed.submissionPerformed, true);
  assert.equal(confirmed.item.state, 'synced');
  assert.equal(confirmed.item.noteId, first.id);
  assert.equal(confirmed.item.sessionId, session.id);
  assert.equal(serverNotes(), 2);
  const firstPosts = posts.filter((post) => post.id === first.id);
  assert.equal(firstPosts.length, 2);
  assert.equal(firstPosts[0].digest, firstPosts[1].digest);
  const beforeAcknowledged = proxyRequests;
  const acknowledged = await retry(first.id, { online: false });
  assert.equal(acknowledged.mode, 'already_acknowledged');
  assert.equal(acknowledged.submissionPerformed, false);
  assert.equal(proxyRequests, beforeAcknowledged);
  writeBinding(repository.id, session.id);
  const acknowledgedBytes = hash(readFileSync(outboxPath));
  const duplicateAcknowledgedArgs = [
    'session',
    'note',
    '--queue',
    '--text',
    first.body,
    '--kind',
    first.kind,
    '--note-id',
    first.id,
  ];
  for (const eventId of first.eventIds) duplicateAcknowledgedArgs.push('--event', eventId);
  const queuedAcknowledged = await cli(duplicateAcknowledgedArgs);
  assert.equal(queuedAcknowledged.mode, 'already_acknowledged');
  assert.equal(queuedAcknowledged.serverContacted, false);
  assert.equal(queuedAcknowledged.item.state, 'synced');
  assert.equal(hash(readFileSync(outboxPath)), acknowledgedBytes);
  assert.equal(proxyRequests, beforeAcknowledged);
  writeBinding(repository.id, nextSession.id);

  stage = 'deleted and conflicting rows remain pending while another selected note succeeds';
  const beforeDeletedPosts = posts.length;
  await retry(deleted.id, { expected: 1 });
  assert.equal(posts.length, beforeDeletedPosts);
  await retry(conflict.id, { expected: 1 });
  assert.equal(store.getSessionNote(context, conflict.id).body, existingConflict.body);
  const healthyResult = await retry(healthy.id);
  assert.equal(healthyResult.item.state, 'synced');
  assert.equal(healthyResult.item.noteId, healthy.id);
  const blocked = await list({ state: 'pending' });
  assert.ok(blocked.items.some((item) => item.noteId === deleted.id));
  assert.ok(blocked.items.some((item) => item.noteId === conflict.id));
  assert.ok(!blocked.items.some((item) => item.noteId === healthy.id));

  stage = 'unsupported acknowledgment retains evidence until the exact server record is confirmed';
  unsupportedAckIds.add(unsupported.id);
  await retry(unsupported.id, { expected: 1 });
  assert.equal(
    (await list()).items.find((item) => item.noteId === unsupported.id).state,
    'pending',
  );
  const storedUnsupported = store.getSessionNote(context, unsupported.id);
  assert.equal(storedUnsupported.author.id, context.user.id);
  const beforeSupported = serverNotes();
  assert.equal((await retry(unsupported.id)).item.state, 'synced');
  assert.equal(serverNotes(), beforeSupported);
  assert.equal(posts.filter((post) => post.id === unsupported.id).length, 2);
  assert.equal(proxyFailure, false);

  stage = 'read-only pagination and actual API CLI MCP agree on the accepted original note';
  const finalOutboxHash = hash(readFileSync(outboxPath));
  const beforeReads = serverChanges();
  const seen = [];
  const seenIds = new Set();
  let after;
  let terminated = false;
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    const page = await list({ limit: 2, after });
    assert.deepEqual(page.totals, { all: 5, pending: 2, synced: 3 });
    for (const item of page.items) {
      assert.ok(!seenIds.has(item.noteId), 'Journal pagination repeated a note.');
      seenIds.add(item.noteId);
      seen.push(item.noteId);
      assert.ok(seen.length <= 5, 'Journal pagination exceeded the fixture membership.');
    }
    const next = page.page.nextAfter;
    if (next === null) {
      terminated = true;
      break;
    }
    assert.ok(
      Number.isSafeInteger(next) && next > 0 && next > (after ?? 0),
      'Journal pagination must advance through positive row cursors.',
    );
    assert.ok(page.items.length > 0, 'An empty journal page cannot continue.');
    after = next;
  }
  assert.equal(terminated, true, 'Journal pagination did not terminate within three pages.');
  assert.deepEqual(seen, [first.id, deleted.id, unsupported.id, conflict.id, healthy.id]);
  assert.equal(new Set(seen).size, 5);
  assert.equal(hash(readFileSync(outboxPath)), finalOutboxHash);
  const notePage = await cli(['session', 'notes', session.id, '--limit', '50'], {
    online: true,
    metadataOnly: false,
  });
  assert.ok(Check(SessionNotesPageSchema, notePage));
  assert.deepEqual(
    notePage.items.find((item) => item.id === first.id),
    persistedFirst,
  );
  const apiResponse = await fetch(`${apiOrigin}/v1/ask`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'OfflineJournalRecallMarker', repositoryIds: [repository.id] }),
  });
  assert.equal(apiResponse.status, 200);
  const answer = await responseBody(apiResponse);
  assert.ok(Check(RecallAnswerSchema, answer));
  assert.deepEqual(
    answer.sources.find((source) => source.id === first.id),
    sessionNoteCitation(persistedFirst),
  );
  for (const eventId of eventIds) assert.ok(answer.sources.some((source) => source.id === eventId));
  mcp = startMcp();
  await mcp.initialize();
  const detail = await mcp.tool('get_session_note', { id: first.id });
  const { bodyExcerpted, ...mcpNote } = detail.note;
  assert.equal(bodyExcerpted, false);
  assert.ok(Check(SessionNoteResponseSchema, { note: mcpNote }));
  assert.deepEqual(mcpNote, persistedFirst);
  const search = await mcp.tool('search_session_notes', {
    query: 'OfflineJournalRecallMarker',
    repositoryIds: [repository.id],
    limit: 5,
  });
  assert.deepEqual(
    search.items.map((item) => item.id),
    [first.id],
  );
  assert.deepEqual(search.items[0].sources, persistedFirst.sources);
  assert.equal(serverChanges(), beforeReads);
  assert.equal(providerCalls, 0);
  assert.equal(readFileSync(configurationPath, 'utf8'), finalBinding);
  assert.equal(hash(readFileSync(outboxPath)), finalOutboxHash);
  await mcp.close();
  mcp = undefined;
  report = {
    status: 'passed',
    syntheticFixturesOnly: true,
    fixtureCommandsExecuted: false,
    remoteProvidersCalled: false,
    providerCalls,
    queuedNotes: 5,
    finalPending: 2,
    finalSynced: 3,
    serverNotes: serverNotes(),
    lostResponseRetriesPreserveIdentity: true,
    selectedRetryIsolation: true,
    peerAndScopeFences: true,
    unsupportedAckRetained: true,
    metadataOnlyInspection: true,
    compiledCli: true,
    mcpStdio: true,
    apiRequests,
    checkedAt: new Date().toISOString(),
  };
} catch {
  console.error(
    `Journal outbox acceptance failed during ${stage}; no journal text or credentials were printed.`,
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
    await closeServer(proxy);
    await closeServer(guard);
    await app.close();
  } catch {
    cleanupFailed = true;
  }
  if (!cleanupFailed) {
    const item = lstatSync(fixture);
    const target = realpathSync(fixture);
    if (
      !item.isDirectory() ||
      item.isSymbolicLink() ||
      target !== fixture ||
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-journal-outbox-')
    )
      throw new Error('Unsafe journal outbox acceptance cleanup target.');
    rmSync(target, { recursive: true, force: true });
  } else {
    report.status = 'failed';
    report.stage = 'owned process cleanup';
    process.exitCode = 1;
  }
  safe(report, true);
  mkdirSync(join(root, '.memvora'), { recursive: true });
  writeFileSync(
    join(root, '.memvora', 'journal-outbox-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(root, '.memvora', 'journal-outbox-acceptance.json'),
    }),
  );
}
