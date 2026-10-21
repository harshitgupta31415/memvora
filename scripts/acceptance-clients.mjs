import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { Check } from 'typebox/value';
import {
  EventSchema,
  MemoryResponseSchema,
  SearchResponseSchema,
} from '../packages/contracts/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';

// The artifact is private/local. All credentials, captures and API data below are disposable fixtures.
const root = resolve(import.meta.dirname, '..');
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-clients-'));
const installation = join(fixture, 'installation');
const captureDirectory = join(fixture, 'capture');
const probeDirectory = join(fixture, 'unconfigured-client');
const absentDirectory = join(fixture, 'absent-outbox');
const serverDirectory = join(fixture, 'server-data');
const cache = join(fixture, 'empty-npm-cache');
const token = randomBytes(32).toString('hex');
const trapToken = `UnrelatedPortableStoreFixture${randomBytes(24).toString('hex')}`;
const foreignMarker = 'ForeignPackagedClientScopeMustStayPrivate';
const query = 'MemvoraPackagedClientQXZ9071Error';
const version = '0.4.0';
const children = new Set();
const states = new WeakMap();
const steps = [];
const toolsExpected = [
  'memvora_status',
  'find_sessions',
  'search_memory',
  'get_memory',
  'search_repository_sources',
  'get_repository_source',
  'get_session_context',
  'get_session_recap',
  'get_session_handover',
  'search_session_notes',
  'get_session_note',
  'get_session_notes',
].sort();
let stage = 'artifact validation';
let store;
let app;
let proxy;
let apiOrigin;
let origin;
let uploadUnavailable = true;
let requests = 0;
let providerCalls = 0;
let capturedId;
let installedPackage;
let cliEntry;
let mcpEntry;
let packageReport;
let acceptanceReport;
const batches = [];

const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  const upper = name.toUpperCase();
  if (
    upper.startsWith('MEMVORA_') ||
    upper.startsWith('AI_') ||
    upper.startsWith('GITHUB_') ||
    upper.startsWith('GH_') ||
    upper.startsWith('GIT_') ||
    upper.startsWith('NPM_CONFIG_') ||
    upper.startsWith('DOTENV_') ||
    upper === 'NODE_PATH' ||
    upper === 'NODE_OPTIONS'
  )
    delete environment[name];
}
Object.assign(environment, {
  NODE_OPTIONS: '--max-old-space-size=1536 --v8-pool-size=1',
  UV_THREADPOOL_SIZE: '2',
  GIT_CEILING_DIRECTORIES: fixture,
  NO_UPDATE_NOTIFIER: '1',
});

function safe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const hidden of [token, trapToken, foreignMarker])
    assert.ok(!text.includes(hidden), 'Private package fixture data was exposed.');
}
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
function inside(parent, target) {
  const path = relative(parent, resolve(target));
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function owned(target) {
  assert.ok(inside(fixture, target), 'A package fixture path escaped its disposable root.');
  return target;
}
function files(directory) {
  const found = [];
  function visit(current, prefix) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = lstatSync(path);
      assert.equal(
        info.isSymbolicLink(),
        false,
        'Installed package contains a workspace/symbolic link.',
      );
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (info.isDirectory()) visit(path, name);
      else {
        assert.ok(info.isFile(), 'Installed package contains a nonregular payload.');
        found.push({ path: name, size: info.size, sha256: hash(readFileSync(path)) });
      }
    }
  }
  visit(directory, '');
  return found.sort((left, right) => left.path.localeCompare(right.path));
}
async function waitClosed(state, timeout) {
  if (state.closed) return true;
  let timer;
  try {
    return await Promise.race([
      state.done.then(() => true),
      new Promise((done) => {
        timer = setTimeout(() => done(false), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(child) {
  const state = states.get(child);
  if (!state) throw new Error('Refusing cleanup of an unowned client process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitClosed(state, 1000)) return;
      throw new Error('Client process cleanup could not be confirmed; fixture retained.');
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
          if (error?.code !== 'ESRCH') throw new Error('Client process group cleanup failed.');
        }
        if (signal === 'SIGTERM' && (await waitClosed(state, 1000))) return;
      }
    }
    if (!(await waitClosed(state, 3000))) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      throw new Error('Client process cleanup could not be confirmed; fixture retained.');
    }
  })();
  return state.stopping;
}
function start(
  file,
  args,
  {
    cwd = probeDirectory,
    env = environment,
    stdin = false,
    maxBytes = 512 * 1024,
    ...options
  } = {},
) {
  owned(cwd);
  const child = spawn(file, args, {
    cwd,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    ...options,
  });
  const state = {
    closed: false,
    stopping: undefined,
    stdout: '',
    stderr: '',
    bytes: 0,
    exceeded: false,
    error: false,
  };
  state.done = new Promise((done) =>
    child.once('close', (code, signal) => {
      state.closed = true;
      children.delete(child);
      done({ code, signal });
    }),
  );
  child.on('error', () => {
    state.error = true;
  });
  for (const channel of ['stdout', 'stderr'])
    child[channel].on('data', (chunk) => {
      state.bytes += chunk.length;
      if (state.bytes > maxBytes) {
        state.exceeded = true;
        void stop(child).catch(() => {});
        return;
      }
      state[channel] += chunk.toString('utf8');
    });
  children.add(child);
  states.set(child, state);
  return child;
}
async function run(file, args, options = {}) {
  const { expected = 0, timeout = 30_000, ...spawnOptions } = options;
  const child = start(file, args, spawnOptions);
  const state = states.get(child);
  let timedOut = false;
  let timer;
  const deadline = new Promise((_done, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void stop(child)
        .finally(() => reject(new Error('Installed client command exceeded its deadline.')))
        .catch(() => {});
    }, timeout);
  });
  try {
    const result = await Promise.race([state.done, deadline]);
    assert.equal(timedOut, false, 'Installed client command exceeded its deadline.');
    assert.equal(state.exceeded, false, 'Installed client output exceeded its budget.');
    assert.equal(state.error, false, 'Installed client process could not start.');
    assert.equal(result.signal, null, 'Installed client terminated unexpectedly.');
    assert.equal(result.code, expected, 'Installed client returned an unexpected exit status.');
    safe(state.stdout);
    safe(state.stderr);
    return { stdout: state.stdout, stderr: state.stderr };
  } finally {
    clearTimeout(timer);
    if (state.stopping) await state.stopping.catch(() => {});
  }
}
function cli(args, options = {}) {
  return run(process.execPath, [cliEntry, ...args], options);
}
function shimInvocation(name, args = []) {
  const shim = join(
    installation,
    'node_modules',
    '.bin',
    `${name}${process.platform === 'win32' ? '.cmd' : ''}`,
  );
  assert.ok(existsSync(shim), 'Installed executable shim is missing.');
  if (process.platform !== 'win32') return { file: shim, args };
  // Only fixed test switches use this shell path. Protocol text remains on stdin, never shell arguments.
  assert.ok(args.every((argument) => /^--[a-z-]+$/u.test(argument)));
  assert.ok(!/["%\r\n]/u.test(shim));
  return {
    file: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', `""${shim}"${args.length ? ` ${args.join(' ')}` : ''}"`],
    windowsVerbatimArguments: true,
  };
}
async function shim(name, args, options = {}) {
  const invocation = shimInvocation(name, args);
  return run(invocation.file, invocation.args, {
    ...options,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}
function npmEntry() {
  const prefix = dirname(dirname(process.execPath));
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const directory of (environment['PATH'] ?? environment['Path'] ?? '').split(
    sep === '\\' ? ';' : ':',
  )) {
    if (!isAbsolute(directory)) continue;
    candidates.push(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (process.platform !== 'win32') {
      try {
        const executable = realpathSync(join(directory, 'npm'));
        if (basename(executable) === 'npm-cli.js') candidates.push(executable);
      } catch {
        /* A missing PATH entry cannot select a shell wrapper or workspace dependency. */
      }
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  throw new Error('The active Node installation has no npm JavaScript entrypoint.');
}
async function npm(args) {
  owned(installation);
  return run(
    process.execPath,
    [
      npmEntry(),
      ...args,
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--update-notifier=false',
      '--package-lock=false',
      '--cache',
      cache,
      '--userconfig',
      join(fixture, 'private-empty-user.npmrc'),
      '--globalconfig',
      join(fixture, 'private-empty-global.npmrc'),
      '--registry',
      'http://127.0.0.1:1',
    ],
    { cwd: installation, timeout: 45_000, maxBytes: 1024 * 1024 },
  );
}
function offlineSnapshot() {
  return [
    probeDirectory,
    join(fixture, '.memvora'),
    join(installation, 'node_modules', '.memvora'),
  ].map((directory) => ({ directory, files: files(directory) }));
}
function outboxRow() {
  const database = new DatabaseSync(join(captureDirectory, '.memvora', 'outbox.sqlite'), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare('SELECT id,session_id,sequence,payload,synced FROM executions ORDER BY rowid')
      .all();
    assert.equal(rows.length, 1, 'Installed capture changed the expected event membership.');
    return { ...rows[0], payload: JSON.parse(rows[0].payload) };
  } finally {
    database.close();
  }
}
async function http(path, body, expected = 200) {
  const response = await fetch(new URL(path, apiOrigin), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, 'Disposable API returned an unexpected status.');
  const result = await response.json();
  safe(result);
  return result;
}
function protocol({ env, installedShim = false } = {}) {
  const invocation = installedShim
    ? shimInvocation('memvora-mcp')
    : { file: process.execPath, args: [mcpEntry] };
  const child = start(invocation.file, invocation.args, {
    env: env ?? environment,
    stdin: true,
    maxBytes: 2 * 1024 * 1024,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  let id = 0;
  let failure;
  const waiting = new Map();
  function fail(error) {
    failure ??= error;
    for (const waiter of waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiting.clear();
  }
  child.on('error', () => fail(new Error('Installed MCP could not start.')));
  child.once('close', () => {
    if (waiting.size) fail(new Error('Installed MCP exited before its response.'));
  });
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > 256 * 1024)
      return fail(new Error('Installed MCP frame exceeded its budget.'));
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
          if (message.error) waiter.reject(new Error('Installed MCP returned a protocol error.'));
          else waiter.resolve(message.result);
        }
      } catch {
        fail(new Error('Installed MCP stdout was not safe protocol JSON.'));
      }
    }
  });
  function call(method, params) {
    if (failure) return Promise.reject(failure);
    const requestId = ++id;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error('Installed MCP request timed out.'));
      }, 15_000);
      waiting.set(requestId, { resolve: resolveCall, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  async function tool(name, input, errorExpected = false) {
    const result = await call('tools/call', { name, arguments: input });
    safe(result);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 128 * 1024);
    if (errorExpected) {
      assert.equal(
        result.isError,
        true,
        'Installed MCP unexpectedly returned authorized evidence.',
      );
      assert.ok(!JSON.stringify(result).includes(capturedId ?? 'no-captured-event-yet'));
      return result;
    }
    assert.ok(!result.isError, 'Installed MCP tool unexpectedly failed.');
    return JSON.parse(result.content[0].text);
  }
  async function initialize() {
    const result = await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'memvora-private-client-acceptance', version: '1.0.0' },
    });
    assert.equal(result.serverInfo.version, version);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const listing = await call('tools/list', {});
    assert.deepEqual(listing.tools.map((definition) => definition.name).sort(), toolsExpected);
    assert.ok(listing.tools.every((definition) => definition.annotations?.readOnlyHint === true));
  }
  async function end() {
    child.stdin.end();
    assert.ok(
      await waitClosed(states.get(child), 5000),
      'Installed MCP did not exit on stdin EOF.',
    );
    const state = states.get(child);
    assert.equal(child.exitCode, 0, 'Installed MCP failed during EOF shutdown.');
    assert.equal(state.exceeded, false);
    assert.equal(state.error, false);
    buffer += decoder.end();
    assert.equal(buffer.trim(), '');
    safe(state.stdout);
    safe(state.stderr);
    if (failure) throw failure;
  }
  return { initialize, tool, end };
}

try {
  assert.ok(
    [24, 26].includes(Number(process.versions.node.split('.')[0])),
    'Use supported Node 24 or 26.',
  );
  assert.equal(
    inside(root, fixture),
    false,
    'Client installation must be outside the source checkout.',
  );
  packageReport = JSON.parse(
    readFileSync(join(root, '.memvora', 'client-packages', 'latest.json'), 'utf8'),
  );
  assert.equal(packageReport.format, 'memvora-private-clients');
  assert.equal(packageReport.version, version);
  assert.equal(packageReport.nodeEngines, '^24.0.0 || ^26.0.0');
  assert.ok(isAbsolute(packageReport.tarball));
  const artifact = realpathSync(packageReport.tarball);
  assert.ok(inside(realpathSync(join(root, '.memvora', 'client-packages')), artifact));
  assert.ok(
    lstatSync(packageReport.tarball).isFile() && !lstatSync(packageReport.tarball).isSymbolicLink(),
  );
  const bytes = readFileSync(artifact);
  assert.equal(bytes.byteLength, packageReport.byteLength);
  assert.equal(hash(bytes), packageReport.sha256);
  for (const directory of [installation, captureDirectory, probeDirectory, serverDirectory, cache])
    mkdirSync(directory);
  assert.deepEqual(readdirSync(cache), []);
  const tarball = join(fixture, 'private-clients.tgz');
  copyFileSync(artifact, tarball, constants.COPYFILE_EXCL);
  writeFileSync(
    join(installation, 'package.json'),
    JSON.stringify({ name: 'memvora-disposable-client-install', private: true }),
  );
  for (const name of ['private-empty-user.npmrc', 'private-empty-global.npmrc'])
    writeFileSync(join(fixture, name), '');

  stage = 'offline installation';
  await npm(['install', tarball, '--no-save']);
  installedPackage = join(installation, 'node_modules', '@memvora', 'clients');
  assert.equal(lstatSync(installedPackage).isSymbolicLink(), false);
  const manifest = JSON.parse(readFileSync(join(installedPackage, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@memvora/clients');
  assert.equal(manifest.version, version);
  assert.equal(manifest.private, true);
  assert.equal(manifest.engines.node, '^24.0.0 || ^26.0.0');
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.equal(manifest.scripts?.[hook], undefined);
  assert.equal(manifest.bin.memvora.replace(/^\.\//u, ''), 'bin/memvora.mjs');
  assert.equal(manifest.bin['memvora-mcp'].replace(/^\.\//u, ''), 'bin/memvora-mcp.mjs');
  const installedFiles = files(installedPackage);
  assert.deepEqual(
    installedFiles,
    [...packageReport.files].sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.deepEqual(
    readdirSync(join(installation, 'node_modules'))
      .filter((name) => !name.startsWith('.'))
      .sort(),
    ['@memvora'],
  );
  assert.deepEqual(readdirSync(join(installation, 'node_modules', '@memvora')), ['clients']);
  cliEntry = join(installedPackage, 'bin', 'memvora.mjs');
  mcpEntry = join(installedPackage, 'bin', 'memvora-mcp.mjs');
  for (const entry of [cliEntry, mcpEntry])
    assert.match(readFileSync(entry, 'utf8'), /^#!\/usr\/bin\/env node/u);
  steps.push(
    'Installed verified tarball offline with an empty cache, no runtime dependencies or hooks, and real package files.',
  );

  stage = 'portable configuration isolation';
  const traps = [
    join(fixture, '.memvora'),
    join(probeDirectory, '.memvora'),
    join(installation, 'node_modules', '.memvora'),
  ];
  for (const directory of traps) {
    mkdirSync(directory);
    writeFileSync(join(directory, 'local-token'), `${trapToken}\n`);
    writeFileSync(
      join(directory, 'server.sqlite'),
      'Unrelated fixture store; never open this file.',
    );
  }
  for (const directory of [fixture, probeDirectory, installation])
    writeFileSync(
      join(directory, '.env'),
      `MEMVORA_LOCAL_TOKEN=${trapToken}\nMEMVORA_DATA_DIR=${serverDirectory.replaceAll('\\', '/')}\n`,
    );
  writeFileSync(join(captureDirectory, '.git'), 'gitdir: missing-synthetic-boundary\n');
  writeFileSync(join(probeDirectory, '.git'), 'gitdir: missing-synthetic-boundary\n');
  const baseline = offlineSnapshot();
  const help = await cli(['--help']);
  assert.match(help.stdout, /capture|memvora/iu);
  assert.equal((await cli(['--version'])).stdout.trim(), version);
  assert.equal((await shim('memvora', ['--version'])).stdout.trim(), version);
  assert.match((await shim('memvora', ['--help'])).stdout, /capture|memvora/iu);
  const offline = JSON.parse(
    (await cli(['outbox', 'list', '--directory', absentDirectory])).stdout,
  );
  assert.equal(offline.source, 'local_outbox');
  assert.equal(offline.exists, false);
  assert.deepEqual(offline.items, []);
  assert.equal(existsSync(absentDirectory), false);

  writeFileSync(join(serverDirectory, 'local-token'), `${token}\n`, { mode: 0o600 });
  store = new SqliteEvidenceStore(join(serverDirectory, 'server.sqlite'));
  app = buildApp({
    store,
    token,
    embeddedWorker: false,
    enricher: async () => {
      providerCalls++;
      throw new Error('No provider may run in packaged-client acceptance.');
    },
  });
  apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  proxy = createServer((request, response) => {
    void (async () => {
      requests++;
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new Error('Fixture proxy body limit.');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (request.method === 'POST' && request.url === '/v1/events/batch') {
        const batch = JSON.parse(body.toString('utf8'));
        batches.push({
          ids: batch.events.map((event) => event.eventId),
          rejected: uploadUnavailable,
        });
        if (uploadUnavailable) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                code: 'SYNTHETIC_UPLOAD_UNAVAILABLE',
                message: 'Synthetic upload fixture is temporarily unavailable.',
              },
            }),
          );
          return;
        }
      }
      const target = new URL(request.url, apiOrigin);
      assert.equal(target.origin, apiOrigin);
      const upstream = await fetch(target, {
        method: request.method,
        redirect: 'error',
        headers: {
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          ...(request.headers['content-type']
            ? { 'content-type': request.headers['content-type'] }
            : {}),
        },
        ...(body.length ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      const value = await upstream.text();
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      response.end(value);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'FIXTURE_PROXY_FAILED' } }));
    });
  });
  await new Promise((done, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', done);
  });
  origin = `http://127.0.0.1:${proxy.address().port}`;
  const noCredential = { ...environment, MEMVORA_API_URL: origin };
  const beforeMissing = requests;
  for (const args of [
    ['login'],
    ['status'],
    ['init'],
    ['--home', join(fixture, 'missing-explicit-home'), 'login'],
  ]) {
    const result = await cli(args, { env: noCredential, expected: 1 });
    assert.equal(result.stdout.trim(), '');
    assert.ok(result.stderr.trim());
  }
  const missingMcp = protocol({ env: noCredential, installedShim: true });
  await missingMcp.initialize();
  const missing = await missingMcp.tool('memvora_status', {}, true);
  assert.match(missing.content[0].text, /MEMVORA_DATA_DIR|credential|configured|explicit/iu);
  await missingMcp.end();
  assert.equal(
    requests,
    beforeMissing,
    'Unconfigured portable clients probed a guessed credential store/API.',
  );
  assert.deepEqual(offlineSnapshot(), baseline);
  assert.equal(existsSync(join(fixture, 'missing-explicit-home')), false);
  const override = await cli(['login'], { env: { ...noCredential, MEMVORA_LOCAL_TOKEN: token } });
  assert.match(override.stdout, /verified/iu);
  assert.deepEqual(offlineSnapshot(), baseline);
  steps.push(
    'Help, version and offline inspection need no credential; cwd/ancestor environment and guessed stores are ignored.',
  );

  stage = 'installed CLI capture and selective retry';
  const configured = { ...environment, MEMVORA_API_URL: origin, MEMVORA_DATA_DIR: serverDirectory };
  assert.match((await cli(['login'], { env: configured })).stdout, /verified/iu);
  const status = JSON.parse(
    (await cli(['--home', serverDirectory, 'status'], { env: noCredential })).stdout,
  );
  assert.equal(status.mode, 'local');
  await cli(['init'], { cwd: captureDirectory, env: configured });
  const configuration = join(captureDirectory, '.memvora', 'config.json');
  const binding = JSON.parse(readFileSync(configuration, 'utf8'));
  assert.equal(binding.apiUrl, origin);
  const { session } = store.getSession(store.context(), binding.sessionId);
  assert.equal(session.repositoryId, binding.repositoryId);
  assert.equal(session.eventCount, 0);
  const execution = await cli(
    [
      'run',
      '--',
      process.execPath,
      '-e',
      `process.stderr.write(${JSON.stringify(`${query}: actual disposable Node failure\n`)});process.exit(7)`,
    ],
    { cwd: captureDirectory, env: configured, expected: 7 },
  );
  assert.ok(execution.stderr.includes(query));
  const pending = outboxRow();
  capturedId = pending.id;
  assert.ok(Check(EventSchema, pending.payload));
  assert.equal(pending.payload.eventId, capturedId);
  assert.equal(pending.payload.repositoryId, binding.repositoryId);
  assert.equal(pending.payload.sessionId, binding.sessionId);
  assert.equal(pending.payload.outcome.exitCode, 7);
  assert.equal(pending.payload.outcome.kind, 'completed');
  assert.ok(pending.payload.output.some((chunk) => chunk.text.includes(query)));
  assert.equal(pending.synced, 0);
  assert.equal(store.getSession(store.context(), binding.sessionId).session.eventCount, 0);
  await cli(['sync', '--event', capturedId], {
    cwd: captureDirectory,
    env: configured,
    expected: 1,
  });
  assert.deepEqual(outboxRow(), pending);
  uploadUnavailable = false;
  const synced = JSON.parse(
    (await cli(['sync', '--event', capturedId], { cwd: captureDirectory, env: configured })).stdout,
  );
  assert.equal(synced.acknowledgedEvents, 1);
  assert.equal(outboxRow().synced, 1);
  assert.deepEqual(outboxRow().payload, pending.payload);
  assert.equal(store.getSession(store.context(), binding.sessionId).session.eventCount, 1);
  assert.deepEqual(batches, [
    { ids: [capturedId], rejected: true },
    { ids: [capturedId], rejected: true },
    { ids: [capturedId], rejected: false },
  ]);
  const again = JSON.parse(
    (await cli(['sync', '--event', capturedId], { cwd: captureDirectory, env: configured })).stdout,
  );
  assert.equal(again.acknowledgedEvents, 0);
  const answer = await cli(['ask', query, '--repository', binding.repositoryId], {
    cwd: captureDirectory,
    env: configured,
  });
  assert.ok(answer.stdout.includes(capturedId));
  assert.ok(answer.stdout.includes(query));
  const raw = await http('/v1/memories/search', {
    query,
    repositoryIds: [binding.repositoryId],
    limit: 5,
  });
  assert.ok(Check(SearchResponseSchema, raw));
  assert.equal(raw.items.length, 1);
  assert.equal(raw.items[0].id, capturedId);
  assert.equal(raw.items[0].representation, 'raw_event');
  assert.equal(raw.items[0].processingStatus, 'queued');
  assert.equal(
    store.database.prepare('SELECT count(*) AS count FROM local_memories').get().count,
    0,
  );
  steps.push(
    'Actual installed CLI captured exit7, retained rejected uploads and selectively retried the same UUID before cited raw Ask.',
  );

  stage = 'installed MCP evidence and scope';
  const context = store.context();
  const emptyRepository = store.createRepository(context, {
    name: 'Synthetic empty portable-client scope',
  });
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
  const mcp = protocol({ env: configured });
  await mcp.initialize();
  const callsBeforeRead = providerCalls;
  const changesBeforeRead = store.database.prepare('SELECT total_changes() AS count').get().count;
  const metadata = await mcp.tool('memvora_status', {});
  assert.equal(metadata.stage, 'local_mvp');
  const found = await mcp.tool('search_memory', {
    query,
    repositoryIds: [binding.repositoryId],
    limit: 5,
  });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].id, capturedId);
  assert.equal(found.items[0].representation, 'raw_event');
  assert.equal(found.items[0].processingStatus, 'queued');
  const detail = await mcp.tool('get_memory', { id: capturedId });
  assert.ok(Check(MemoryResponseSchema, { memory: detail.memory }));
  assert.equal(detail.memory.id, capturedId);
  assert.equal(detail.memory.repositoryId, binding.repositoryId);
  assert.deepEqual(
    detail.memory.sources.map((source) => source.id),
    [capturedId],
  );
  const page = await mcp.tool('get_session_context', { id: binding.sessionId, limit: 5 });
  assert.equal(page.session.id, binding.sessionId);
  assert.deepEqual(
    page.events.map((event) => event.eventId),
    [capturedId],
  );
  assert.equal(page.events[0].outcome.exitCode, 7);
  assert.equal(page.page.snapshotEventCount, 1);
  assert.deepEqual(
    (await mcp.tool('search_memory', { query, repositoryIds: [], limit: 5 })).items,
    [],
  );
  assert.deepEqual(
    (await mcp.tool('search_memory', { query, repositoryIds: [emptyRepository.id], limit: 5 }))
      .items,
    [],
  );
  await mcp.tool('search_memory', { query, repositoryIds: [foreignRepository.id], limit: 5 }, true);
  const beforeUnknown = requests;
  await mcp.tool('search_memory', { query, repositoryId: binding.repositoryId }, true);
  assert.equal(requests, beforeUnknown, 'Unknown MCP selectors reached the API.');
  assert.equal(providerCalls, callsBeforeRead);
  assert.equal(
    store.database.prepare('SELECT total_changes() AS count').get().count,
    changesBeforeRead,
  );
  await mcp.end();
  const wrongMcp = protocol({ env: { ...configured, MEMVORA_LOCAL_TOKEN: trapToken } });
  await wrongMcp.initialize();
  await wrongMcp.tool('get_memory', { id: capturedId }, true);
  await wrongMcp.end();
  assert.equal(providerCalls, 0);
  steps.push(
    'Installed MCP discovered12 read-only tools, retained original UUIDs and denied unknown/foreign/wrong-credential selectors without enrichment.',
  );

  stage = 'reinstall and uninstall retention';
  store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const retainedPaths = [
    configuration,
    join(captureDirectory, '.memvora', 'outbox.sqlite'),
    join(serverDirectory, 'local-token'),
    join(serverDirectory, 'server.sqlite'),
  ];
  const retained = retainedPaths.map((path) => ({ path, sha256: hash(readFileSync(path)) }));
  const beforePackageOperations = requests;
  const assertRetained = () => {
    for (const entry of retained)
      assert.equal(
        hash(readFileSync(entry.path)),
        entry.sha256,
        'Package maintenance changed local evidence or credentials.',
      );
    assert.deepEqual(outboxRow().payload, pending.payload);
    assert.equal(store.getEvent(context, capturedId).eventId, capturedId);
    assert.equal(requests, beforePackageOperations, 'Package maintenance contacted the API.');
    assert.equal(providerCalls, 0);
  };
  await npm(['install', tarball, '--no-save']);
  assertRetained();
  await npm(['uninstall', '@memvora/clients', '--no-save']);
  assert.equal(existsSync(installedPackage), false);
  assertRetained();
  await npm(['install', tarball, '--no-save']);
  assert.equal((await cli(['--version'])).stdout.trim(), version);
  assert.deepEqual(files(installedPackage), installedFiles);
  assertRetained();
  await npm(['uninstall', '@memvora/clients', '--no-save']);
  assert.equal(existsSync(installedPackage), false);
  assertRetained();
  steps.push(
    'Offline reinstall/removal preserved exact binding, outbox, server database and credential bytes without API access.',
  );

  acceptanceReport = {
    status: 'passed',
    syntheticFixturesOnly: true,
    externalProvidersCalled: false,
    registryPublished: false,
    version,
    node: process.version,
    artifactSha256: packageReport.sha256,
    eventId: capturedId,
    installedPackageUsesRealFiles: true,
    runtimeDependencies: 0,
    toolCount: toolsExpected.length,
    steps,
    checkedAt: new Date().toISOString(),
  };
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown acceptance failure.';
  for (const hidden of [token, trapToken, foreignMarker])
    message = message.replaceAll(hidden, '[redacted fixture]');
  console.error(
    `Private client package acceptance failed during ${stage}: ${message.slice(0, 2000)}`,
  );
  acceptanceReport = {
    status: 'failed',
    syntheticFixturesOnly: true,
    version,
    node: process.version,
    stage,
    steps,
    checkedAt: new Date().toISOString(),
  };
  process.exitCode = 1;
} finally {
  let cleanupFailure = false;
  for (const child of [...children]) {
    try {
      await stop(child);
    } catch {
      cleanupFailure = true;
    }
  }
  if (proxy) {
    proxy.closeIdleConnections();
    proxy.closeAllConnections();
    await new Promise((done) => proxy.close(() => done()));
  }
  if (app) await app.close();
  else store?.close();
  if (cleanupFailure) {
    console.error('Owned client cleanup could not be confirmed; disposable fixture retained.');
    process.exitCode = 1;
    acceptanceReport = {
      status: 'failed',
      syntheticFixturesOnly: true,
      version,
      node: process.version,
      stage: 'owned process cleanup',
      steps,
      checkedAt: new Date().toISOString(),
    };
  } else {
    const entry = lstatSync(fixture);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Unsafe client-package fixture cleanup target.');
    const target = realpathSync(fixture);
    if (
      target !== fixture ||
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-clients-') ||
      !target.startsWith(join(temporaryRoot, 'memvora-clients-'))
    )
      throw new Error('Unsafe client-package fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
  safe(acceptanceReport);
  mkdirSync(join(root, '.memvora'), { recursive: true });
  writeFileSync(
    join(root, '.memvora', 'client-package-acceptance.json'),
    `${JSON.stringify(acceptanceReport, null, 2)}\n`,
  );
  if (acceptanceReport.status === 'passed')
    console.log(
      'Private client package acceptance passed: offline install, actual capture/retry/recall, MCP scope and maintenance retention.',
    );
}
