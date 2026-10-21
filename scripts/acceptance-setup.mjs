import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LocalMemvora } from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { LocalOutbox } from '../apps/cli/dist/local.js';

// Only disposable local folders and labeled metadata in an isolated in-memory store.
const root = resolve(import.meta.dirname, '..');
const fixture = mkdtempSync(join(tmpdir(), 'memvora-setup-'));
const token = randomBytes(32).toString('hex');
const store = new SqliteEvidenceStore(':memory:');
const service = new LocalMemvora(store);
const app = buildApp({ store, token, embeddedWorker: false });
const children = [];
let apiRequests = 0;
app.addHook('onRequest', async () => {
  apiRequests++;
});
const environment = { ...process.env, MEMVORA_DATA_DIR: fixture };
delete environment.MEMVORA_LOCAL_TOKEN;
writeFileSync(join(fixture, 'local-token'), `${token}\n`, { mode: 0o600 });
for (const key of Object.keys(environment))
  if (key.startsWith('GITHUB_') || key.startsWith('GIT_') || key.startsWith('MEMVORA_AI_'))
    delete environment[key];
environment.GIT_CEILING_DIRECTORIES = fixture;
function safe(value) {
  assert.ok(!String(value).includes(token), 'A fixture credential was exposed.');
  assert.ok(!String(value).includes('SetupForeignPrivateName'), 'Foreign metadata was exposed.');
}
function spawnNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.push(child);
  return child;
}
async function cli(cwd, args, expected = 0) {
  const child = spawnNode([resolve(root, 'apps/cli/dist/index.js'), ...args], { cwd });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  const collect = (target) => (chunk) => {
    if (target === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > 256 * 1024) {
      overflow = true;
      child.kill();
    }
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, expected, 'Compiled setup CLI returned an unexpected status.');
    assert.equal(overflow, false);
    safe(stdout);
    safe(stderr);
    if (expected) assert.ok(stderr.trim());
    return { stdout, stderr };
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
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    child.kill();
  });
}
function decodeHtml(value) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#x27|#39);/gu,
    (entity) =>
      ({
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&#x27;': "'",
        '&#39;': "'",
      })[entity],
  );
}
async function verifyMcpConfiguration(configuration, expectedApi) {
  const definition = configuration.mcpServers.memvora;
  assert.equal(definition.command, 'node');
  assert.ok(Array.isArray(definition.args));
  assert.equal(definition.env.MEMVORA_API_URL, expectedApi);
  assert.equal(definition.env.MEMVORA_DATA_DIR, fixture);
  assert.ok(!Object.hasOwn(definition.env, 'MEMVORA_LOCAL_TOKEN'));
  const child = spawnNode(definition.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...environment, ...definition.env },
  });
  child.stderr.resume();
  const pending = new Map();
  let buffer = '';
  let nextId = 0;
  let protocolError;
  const fail = (error) => {
    protocolError = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 512 * 1024) return fail(new Error('Setup MCP buffer exceeded.'));
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        safe(line);
        const waiter = pending.get(response.id);
        if (!waiter) continue;
        pending.delete(response.id);
        clearTimeout(waiter.timer);
        if (response.error) waiter.reject(new Error('Setup MCP protocol returned an error.'));
        else waiter.resolve(response.result);
      } catch {
        fail(new Error('Setup MCP stdout was not valid protocol-only JSON.'));
      }
    }
  });
  child.on('error', () => fail(new Error('Setup MCP process failed.')));
  child.on('exit', () => fail(new Error('Setup MCP exited before its response.')));
  const call = (method, params) => {
    if (protocolError) return Promise.reject(protocolError);
    const id = ++nextId;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Setup MCP request timed out.'));
      }, 15_000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  try {
    await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'memvora-setup-acceptance', version: '1.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const result = await call('tools/call', { name: 'memvora_status', arguments: {} });
    assert.ok(!result.isError, 'Generated MCP configuration could not reach the selected API.');
    assert.equal(JSON.parse(result.content[0].text).stage, 'local_mvp');
    assert.equal(protocolError, undefined);
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    pending.clear();
    child.stdin.end();
    await stop(child);
  }
}
try {
  assert.equal(store.path, ':memory:');
  const context = service.context();
  const selected = service.createRepository({ name: 'Synthetic older setup repository' });
  store.database
    .prepare('UPDATE local_repositories SET created_at=? WHERE id=?')
    .run('2026-01-01T00:00:00.000Z', selected.id);
  for (let index = 0; index < 130; index++)
    service.createRepository({ name: `Synthetic setup noise ${index}` });
  assert.ok(!store.repositories(context).some((repository) => repository.id === selected.id));
  const foreignContext = {
    mode: 'local',
    user: { id: randomUUID(), name: 'Synthetic setup foreign owner' },
    workspace: { id: randomUUID(), name: 'Synthetic setup foreign workspace', generation: 1 },
  };
  store.database
    .prepare(
      'INSERT INTO local_workspaces(id,owner_user_id,name,generation,status,created_at) VALUES(?,?,?,1,?,?)',
    )
    .run(
      foreignContext.workspace.id,
      foreignContext.user.id,
      foreignContext.workspace.name,
      'active',
      new Date().toISOString(),
    );
  const foreign = store.createRepository(foreignContext, { name: 'SetupForeignPrivateName' });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  environment.MEMVORA_API_URL = api;
  const target = join(fixture, "target project 'quoted");
  const fresh = join(fixture, 'new local project');
  const invalid = join(fixture, 'corrupt local project');
  for (const folder of [target, fresh, invalid]) mkdirSync(folder);
  const before = store.dashboard(context).counts;
  await cli(target, ['init', '--repository-id', selected.id]);
  const config = join(target, '.memvora/config.json');
  const firstConfig = readFileSync(config, 'utf8');
  const binding = JSON.parse(firstConfig);
  assert.equal(binding.repositoryId, selected.id);
  assert.ok(binding.sessionId);
  assert.equal(readFileSync(join(target, '.memvora/.gitignore'), 'utf8'), '*\n');
  const afterFirst = store.dashboard(context).counts;
  assert.equal(afterFirst.repositories, before.repositories);
  assert.equal(afterFirst.sessions, before.sessions + 1);
  const outboxPath = join(target, '.memvora/outbox.sqlite');
  const outbox = new LocalOutbox(outboxPath);
  // Labeled unexecuted local metadata, never uploaded or summarized.
  assert.equal(outbox.begin('synthetic-pending', binding.sessionId, { synthetic: true }), 1);
  outbox.finalize('synthetic-pending', { synthetic: true, neverUploaded: true });
  assert.equal(outbox.begin('synthetic-incomplete', binding.sessionId, { synthetic: true }), 2);
  outbox.close();
  const outboxBytes = readFileSync(outboxPath);
  const stable = () => {
    assert.equal(readFileSync(config, 'utf8'), firstConfig);
    assert.deepEqual(readFileSync(outboxPath), outboxBytes);
    assert.deepEqual(store.dashboard(context).counts, afterFirst);
  };
  await cli(target, ['init']);
  stable();
  await cli(target, ['init', '--repository-id', selected.id]);
  stable();
  await cli(target, ['init', '--repository-id', foreign.id], 1);
  stable();
  const beforeInvalidRequest = apiRequests;
  await cli(target, ['init', '--repository-id', 'mistyped-repository'], 1);
  await cli(target, ['--api-url', 'http://127.0.0.1:9', 'init'], 1);
  assert.equal(apiRequests, beforeInvalidRequest);
  stable();
  store.closeSession(context, binding.sessionId);
  const changesBeforeClosedInit = store.database
    .prepare('SELECT total_changes() AS count')
    .get().count;
  const closed = await cli(target, ['init']);
  assert.ok(/closed|session start/iu.test(closed.stdout));
  assert.equal(readFileSync(config, 'utf8'), firstConfig);
  assert.deepEqual(readFileSync(outboxPath), outboxBytes);
  assert.equal(
    store.database.prepare('SELECT total_changes() AS count').get().count,
    changesBeforeClosedInit,
  );
  const { sessionId: omitted, ...repositoryOnly } = binding;
  assert.ok(omitted);
  const repositoryOnlyBytes = `${JSON.stringify(repositoryOnly, null, 2)}\n`;
  writeFileSync(config, repositoryOnlyBytes);
  await cli(target, ['init']);
  assert.equal(readFileSync(config, 'utf8'), repositoryOnlyBytes);
  assert.deepEqual(readFileSync(outboxPath), outboxBytes);
  const corruptConfig = join(invalid, '.memvora/config.json');
  mkdirSync(dirname(corruptConfig));
  writeFileSync(corruptConfig, '{invalid-json-fixture');
  const beforeCorrupt = apiRequests;
  await cli(invalid, ['init'], 1);
  assert.equal(apiRequests, beforeCorrupt);
  assert.equal(readFileSync(corruptConfig, 'utf8'), '{invalid-json-fixture');
  const beforeFresh = store.dashboard(context).counts;
  await cli(fresh, ['init']);
  const freshBytes = readFileSync(join(fresh, '.memvora/config.json'), 'utf8');
  await cli(fresh, ['init']);
  assert.equal(readFileSync(join(fresh, '.memvora/config.json'), 'utf8'), freshBytes);
  assert.equal(store.dashboard(context).counts.repositories, beforeFresh.repositories + 1);
  assert.equal(store.dashboard(context).counts.sessions, beforeFresh.sessions + 1);
  await cli(join(fixture), ['init', '--repository-id', foreign.id], 1);

  const web = `http://127.0.0.1:${await freePort()}`;
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
  website.stdout.resume();
  website.stderr.resume();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (website.exitCode !== null) throw new Error('Compiled setup website exited during startup.');
    try {
      const response = await fetch(`${web}/api/status`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Poll only this isolated loopback website. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready);
  const beforeWeb = store.database.prepare('SELECT total_changes() AS count').get().count;
  const html = async (query = '') => {
    const response = await fetch(`${web}/setup${query}`, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    assert.equal(response.status, 200);
    const value = await response.text();
    safe(value);
    return value;
  };
  const guide = await html();
  assert.ok(guide.includes('mcpServers'));
  assert.ok(guide.includes('dist'));
  assert.ok(guide.includes('PowerShell'));
  assert.ok(!guide.includes('npm run cli -- init'));
  const mcpText = guide.match(
    /<pre[^>]*id="memvora-mcp-configuration"[^>]*>([\s\S]*?)<\/pre>/u,
  )?.[1];
  assert.ok(mcpText, 'Setup guide did not expose its copyable MCP configuration.');
  await verifyMcpConfiguration(JSON.parse(decodeHtml(mcpText)), api);
  const scopedGuide = await html(`?repositoryId=${selected.id}`);
  assert.ok(decodeHtml(scopedGuide).includes(`'--repository-id' '${selected.id}'`));
  for (const query of [
    '?repositoryId=invalid',
    `?repositoryId=${selected.id}&repositoryId=${selected.id}`,
    '?unexpected=true',
  ]) {
    const calls = apiRequests;
    const bad = await html(query);
    assert.ok(!bad.includes(`--repository-id ${selected.id}`));
    assert.ok(!bad.includes('mcpServers'));
    assert.equal(apiRequests, calls, 'Malformed setup URL reached the API.');
  }
  const denied = await html(`?repositoryId=${foreign.id}`);
  assert.ok(!denied.includes('--repository-id'));
  assert.ok(!denied.includes('mcpServers'));
  assert.equal(
    store.database.prepare('SELECT total_changes() AS count').get().count,
    beforeWeb,
    'Setup guide reads wrote to SQLite.',
  );
  store.deleteRepository(context, selected.id);
  const afterDeletion = store.database.prepare('SELECT total_changes() AS count').get().count;
  await cli(target, ['init'], 1);
  assert.equal(readFileSync(config, 'utf8'), repositoryOnlyBytes);
  assert.deepEqual(readFileSync(outboxPath), outboxBytes);
  assert.equal(
    store.database.prepare('SELECT total_changes() AS count').get().count,
    afterDeletion,
  );
  assert.ok(beforeWeb <= afterDeletion);
  const report = {
    completedAt: new Date().toISOString(),
    mode: 'isolated_synthetic_setup_fixture',
    checks: [
      'exact_repository_beyond_recent_list',
      'repeated_init_preserves_binding_and_outbox',
      'closed_and_repository_only_binding_preserved',
      'malformed_conflicting_denied_and_deleted_scope',
      'new_repository_initialized_once',
      'compiled_web_cli_and_mcp_setup',
      'generated_mcp_configuration_actual_stdio_connection',
      'invalid_web_queries_fail_before_api',
      'no_credentials_in_output',
    ],
    notice:
      'Only isolated in-memory repository/session metadata and disposable outbox rows marked synthetic. No commands were executed, no evidence was uploaded, and no user data, GitHub or AI provider was used.',
  };
  mkdirSync(resolve(root, '.memvora'), { recursive: true });
  writeFileSync(
    resolve(root, '.memvora/setup-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all(children.map(stop));
  await app.close();
  const target = resolve(fixture);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('memvora-setup-'))
    throw new Error('Unexpected setup fixture cleanup path.');
  rmSync(target, { recursive: true, force: true });
}
