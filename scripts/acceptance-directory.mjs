import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { Check } from 'typebox/value';
import { SessionDirectoryPageSchema } from '../packages/contracts/dist/index.js';
import { LocalMemvora } from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';

// Synthetic session metadata only. Every API request uses this isolated in-memory store.
const root = resolve(import.meta.dirname, '..');
const token = randomBytes(32).toString('hex');
const store = new SqliteEvidenceStore(':memory:');
const service = new LocalMemvora(store);
const app = buildApp({ store, token, embeddedWorker: false });
let directoryRequests = 0;
app.addHook('onRequest', async (request) => {
  if (request.url.startsWith('/v1/sessions/search') || request.url.startsWith('/v1/repositories'))
    directoryRequests++;
});
const children = [];
const environment = { ...process.env, MEMVORA_LOCAL_TOKEN: token };
for (const key of Object.keys(environment))
  if (key.startsWith('GITHUB_') || key.startsWith('MEMVORA_AI_')) delete environment[key];
const pending = new Map();
let mcp;
let rpcId = 0;
let protocolBuffer = '';
let protocolFailure;
function safe(value) {
  assert.ok(!String(value).includes(token), 'A fixture credential was exposed.');
  assert.ok(
    !String(value).includes('ForeignDirectoryMustRemainHidden'),
    'Foreign fixture metadata was exposed.',
  );
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
async function cli(args, expectedExit = 0) {
  const child = spawnNode([resolve(root, 'apps/cli/dist/index.js'), 'session', 'list', ...args]);
  let stdout = '';
  let stderr = '';
  let overflow = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 512 * 1024) {
      overflow = true;
      child.kill();
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 65536) {
      overflow = true;
      child.kill();
    }
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, expectedExit, 'Compiled directory CLI returned an unexpected exit status.');
    assert.equal(overflow, false);
    safe(stdout);
    safe(stderr);
    if (expectedExit !== 0) {
      assert.equal(stdout.trim(), '');
      assert.ok(stderr.trim());
      return null;
    }
    const page = JSON.parse(stdout);
    assert.ok(Check(SessionDirectoryPageSchema, page));
    return page;
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
      reject(new Error('Directory MCP request timed out.'));
    }, 15_000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function tool(input, expectError = false) {
  const result = await call('tools/call', { name: 'find_sessions', arguments: input });
  safe(JSON.stringify(result));
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 96 * 1024);
  if (expectError) {
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('DirectoryAcceptanceNeedle'));
    return null;
  }
  assert.ok(!result.isError, 'Directory MCP lookup failed.');
  const output = JSON.parse(result.content[0].text);
  const page = { items: output.items, filters: output.filters, page: output.page };
  assert.ok(Check(SessionDirectoryPageSchema, page));
  assert.ok(output.evidenceNotice);
  return page;
}
async function stop(child) {
  child.stdin?.end();
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
try {
  assert.equal(store.path, ':memory:');
  // Direct fixture SQL sets deterministic creation times and one foreign test workspace only.
  const database = store.database;
  const context = service.context();
  const archive = service.createRepository({ name: 'Synthetic directory archive' });
  const recent = service.createRepository({ name: 'Synthetic recent directory noise' });
  const emptyRepository = service.createRepository({ name: 'Synthetic empty directory' });
  function create(repositoryId, title, ordinal, status = 'open', owner = context) {
    const session = store.createSession(owner, { repositoryId, title });
    database
      .prepare('UPDATE local_sessions SET created_at=? WHERE id=?')
      .run(new Date(Date.UTC(2026, 0, 1, 0, ordinal)).toISOString(), session.id);
    if (status === 'closed') store.closeSession(owner, session.id);
    return session;
  }
  const oldest = create(archive.id, 'DirectoryAcceptanceNeedle oldest synthetic investigation', 0);
  const closed = create(
    archive.id,
    'DirectoryAcceptanceNeedle closed synthetic investigation',
    1,
    'closed',
  );
  const hostileText = '<script>globalThis.directoryFixtureMustRemainInert=true</script>';
  const hostile = create(archive.id, `DirectoryAcceptanceNeedle ${hostileText}`, 2);
  const newest = create(
    archive.id,
    'DirectoryAcceptanceNeedle additional synthetic open investigation',
    3,
  );
  for (let index = 0; index < 130; index++)
    create(recent.id, `Synthetic unrelated directory metadata ${index}`, index + 10);
  const foreignContext = {
    mode: 'local',
    user: { id: randomUUID(), name: 'Synthetic foreign owner' },
    workspace: { id: randomUUID(), name: 'Synthetic foreign workspace', generation: 1 },
  };
  database
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
  const foreign = store.createRepository(foreignContext, {
    name: 'Synthetic inaccessible repository',
  });
  create(
    foreign.id,
    'DirectoryAcceptanceNeedle ForeignDirectoryMustRemainHidden',
    200,
    'open',
    foreignContext,
  );
  const beforeChanges = database.prepare('SELECT total_changes() AS count').get().count;
  const beforeDashboard = store.dashboard(context);

  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  environment.MEMVORA_API_URL = api;
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
    if (website.exitCode !== null)
      throw new Error('Compiled directory website exited before startup.');
    try {
      const response = await fetch(`${web}/api/status`, {
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Startup polling stays within the isolated loopback server. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, 'Compiled directory website did not become ready.');
  async function search(input, expected = 200) {
    const response = await fetch(`${api}/v1/sessions/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    assert.equal(response.status, expected, 'Directory API returned an unexpected status.');
    const value = await response.json();
    safe(JSON.stringify(value));
    if (expected === 200) {
      assert.ok(Check(SessionDirectoryPageSchema, value));
      assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
    } else assert.ok(!('items' in value));
    return value;
  }
  async function html(parameters) {
    const suffix =
      typeof parameters === 'string' ? parameters : new URLSearchParams(parameters).toString();
    const response = await fetch(`${web}/sessions?${suffix}`, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    assert.equal(response.status, 200);
    const value = await response.text();
    safe(value);
    return value;
  }
  const itemIds = (value) => [
    ...new Set(
      [...value.matchAll(/href="\/sessions\/([a-fA-F0-9-]{36})"/gu)].map((match) => match[1]),
    ),
  ];
  const ids = (page) => page.items.map((item) => item.id);
  const legacy = await fetch(`${api}/v1/sessions`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  }).then((response) => response.json());
  assert.equal(legacy.items.length, 50);
  assert.ok(!legacy.items.some((item) => item.id === oldest.id));

  mcp = spawnNode([resolve(root, 'apps/mcp/dist/index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  mcp.stderr.resume();
  mcp.stdout.on('data', (chunk) => {
    protocolBuffer += chunk;
    if (protocolBuffer.length > 2 * 1024 * 1024)
      return failProtocol(new Error('Directory MCP buffer exceeded.'));
    while (protocolBuffer.includes('\n')) {
      const end = protocolBuffer.indexOf('\n');
      const line = protocolBuffer.slice(0, end);
      protocolBuffer = protocolBuffer.slice(end + 1);
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return failProtocol(new Error('Directory MCP stdout was not protocol-only.'));
      }
      const waiter = pending.get(value.id);
      if (waiter) {
        pending.delete(value.id);
        clearTimeout(waiter.timer);
        if (value.error) waiter.reject(new Error('Directory MCP protocol request failed.'));
        else waiter.resolve(value.result);
      }
    }
  });
  mcp.on('error', () => failProtocol(new Error('Directory MCP process failed.')));
  mcp.on('exit', () => {
    if (pending.size) failProtocol(new Error('Directory MCP exited before its response.'));
  });
  await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'memvora-directory-acceptance', version: '1.0.0' },
  });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await call('tools/list', {});
  assert.ok(
    tools.tools.some((tool) => tool.name === 'find_sessions' && tool.annotations?.readOnlyHint),
  );
  const beforeRejectedToolFilters = directoryRequests;
  for (const invalid of [
    { repository: archive.id },
    { repositoryIds: [archive.id] },
    { repositoryId: archive.id, includeEverything: true },
  ])
    await tool(invalid, true);
  assert.equal(
    directoryRequests,
    beforeRejectedToolFilters,
    'Unknown MCP filters reached the API.',
  );

  const input = {
    query: 'DirectoryAcceptanceNeedle',
    repositoryId: archive.id,
    status: 'open',
    limit: 2,
  };
  const args = [
    '--repository',
    archive.id,
    '--query',
    input.query,
    '--status',
    input.status,
    '--limit',
    '2',
  ];
  const first = await search(input);
  assert.deepEqual(ids(first), [newest.id, hostile.id]);
  assert.equal(first.page.totalMatching, 3);
  assert.ok(first.page.nextCursor);
  assert.equal(first.page.consistency, 'live');
  assert.deepEqual(await cli(args), first);
  assert.deepEqual(await tool(input), first);
  const firstHtml = await html(input);
  assert.deepEqual(itemIds(firstHtml), ids(first));
  assert.ok(firstHtml.includes('Search investigation titles'));
  assert.ok(firstHtml.includes('Results are live'));
  assert.ok(
    firstHtml.includes(
      '&lt;script&gt;globalThis.directoryFixtureMustRemainInert=true&lt;/script&gt;',
    ),
  );
  assert.ok(!firstHtml.includes(hostileText));
  const form = firstHtml.match(/<form[^>]*action="\/sessions"[^>]*>[\s\S]*?<\/form>/u)?.[0];
  assert.ok(form);
  assert.ok(!form.includes('name="cursor"'));
  for (const name of ['query', 'repositoryId', 'status', 'limit'])
    assert.ok(form.includes(`name="${name}"`));
  const olderHref = [...firstHtml.matchAll(/href="([^"]+)"/gu)]
    .map((match) => match[1].replaceAll('&amp;', '&'))
    .map((path) => new URL(path, web))
    .find(
      (url) =>
        url.pathname === '/sessions' && url.searchParams.get('cursor') === first.page.nextCursor,
    );
  assert.ok(olderHref);
  for (const [key, value] of Object.entries(input))
    assert.equal(olderHref.searchParams.get(key), String(value));
  const secondInput = { ...input, cursor: first.page.nextCursor };
  const second = await search(secondInput);
  assert.deepEqual(ids(second), [oldest.id]);
  assert.equal(second.page.totalMatching, 3);
  assert.equal(second.page.nextCursor, null);
  assert.deepEqual(await cli([...args, '--cursor', first.page.nextCursor]), second);
  assert.deepEqual(await tool(secondInput), second);
  assert.deepEqual(itemIds(await html(secondInput)), ids(second));

  const oldestInput = {
    query: 'oldest synthetic investigation',
    repositoryId: archive.id,
    status: 'open',
    limit: 2,
  };
  const oldestPage = await search(oldestInput);
  assert.deepEqual(ids(oldestPage), [oldest.id]);
  assert.deepEqual(
    await cli([
      '--repository',
      archive.id,
      '--query',
      oldestInput.query,
      '--status',
      'open',
      '--limit',
      '2',
    ]),
    oldestPage,
  );
  assert.deepEqual(await tool(oldestInput), oldestPage);
  assert.deepEqual(itemIds(await html(oldestInput)), [oldest.id]);
  const workspace = await search({ query: input.query, limit: 10 });
  assert.deepEqual(new Set(ids(workspace)), new Set([oldest.id, closed.id, hostile.id, newest.id]));
  assert.deepEqual(
    await cli(['--all-repositories', '--query', input.query, '--limit', '10']),
    workspace,
  );
  assert.deepEqual(await tool({ query: input.query, limit: 10 }), workspace);
  const closedPage = await search({ ...input, status: 'closed' });
  assert.deepEqual(ids(closedPage), [closed.id]);
  assert.deepEqual(
    await cli([
      '--repository',
      archive.id,
      '--query',
      input.query,
      '--status',
      'closed',
      '--limit',
      '2',
    ]),
    closedPage,
  );
  assert.deepEqual(await tool({ ...input, status: 'closed' }), closedPage);
  assert.deepEqual(itemIds(await html({ ...input, status: 'closed' })), [closed.id]);

  const changed = { ...secondInput, status: 'closed' };
  await search(changed, 400);
  await cli(
    [
      '--repository',
      archive.id,
      '--query',
      input.query,
      '--status',
      'closed',
      '--limit',
      '2',
      '--cursor',
      first.page.nextCursor,
    ],
    1,
  );
  await tool(changed, true);
  const invalidCursorHtml = await html(changed);
  assert.deepEqual(itemIds(invalidCursorHtml), []);
  assert.ok(invalidCursorHtml.includes('First page with these filters'));
  const requestsBeforeMalformedUrls = directoryRequests;
  for (const query of [
    `repositoryId=${archive.id}&query=${input.query}&status=invalid`,
    `repositoryId=${archive.id}&limit=2&limit=3`,
    `repositoryId=not-a-uuid`,
    `query=${input.query}&extra=true`,
    `query=${'x'.repeat(201)}`,
    'cursor=',
    `query=${encodeURIComponent('\u0344'.repeat(200))}`,
  ]) {
    const invalid = await html(query);
    assert.deepEqual(itemIds(invalid), []);
    assert.ok(invalid.includes('This directory link has invalid values'));
    assert.ok(invalid.includes('Keep valid filters and restart'));
  }
  assert.equal(
    directoryRequests,
    requestsBeforeMalformedUrls,
    'Malformed web filters reached directory or repository API routes.',
  );
  await search({ ...input, limit: 51 }, 400);
  await cli(['--all-repositories', '--limit', '51'], 1);
  await tool({ ...input, limit: 11 }, true);

  const emptyInput = { repositoryId: emptyRepository.id, limit: 2 };
  const zero = await search(emptyInput);
  assert.equal(zero.page.totalMatching, 0);
  assert.deepEqual(zero.items, []);
  assert.deepEqual(await cli(['--repository', emptyRepository.id, '--limit', '2']), zero);
  assert.deepEqual(await tool(emptyInput), zero);
  assert.deepEqual(itemIds(await html(emptyInput)), []);
  const deniedInput = { repositoryId: foreign.id, limit: 2 };
  await search(deniedInput, 404);
  await cli(['--repository', foreign.id, '--limit', '2'], 1);
  await tool(deniedInput, true);
  const deniedHtml = await html(deniedInput);
  assert.deepEqual(itemIds(deniedHtml), []);
  assert.ok(deniedHtml.includes('The selected repository is unavailable'));
  assert.equal(
    database.prepare('SELECT total_changes() AS count').get().count,
    beforeChanges,
    'Directory reads wrote to SQLite.',
  );
  assert.deepEqual(store.dashboard(context), beforeDashboard);

  store.deleteSession(context, oldest.id);
  const afterOldestDeletion = await search(secondInput);
  assert.equal(afterOldestDeletion.page.totalMatching, 2);
  assert.deepEqual(afterOldestDeletion.items, []);
  const exhausted = await html(secondInput);
  assert.deepEqual(itemIds(exhausted), []);
  assert.ok(exhausted.includes('No investigations remain on this older page'));
  assert.ok(exhausted.includes('Open first page'));
  store.deleteRepository(context, archive.id);
  const afterDeletionChanges = database.prepare('SELECT total_changes() AS count').get().count;
  await search(input, 404);
  await cli(args, 1);
  await tool(input, true);
  const deletedHtml = await html(input);
  assert.deepEqual(itemIds(deletedHtml), []);
  assert.ok(deletedHtml.includes('The selected repository is unavailable'));
  assert.equal(
    database.prepare('SELECT total_changes() AS count').get().count,
    afterDeletionChanges,
    'Denied directory reads wrote to SQLite.',
  );
  const report = {
    completedAt: new Date().toISOString(),
    mode: 'isolated_synthetic_directory_fixture',
    checks: [
      'older_than_recent_50',
      'server_title_scope_before_limit',
      'compiled_web_filter_form_and_live_paging',
      'compiled_cli_pages',
      'actual_read_only_stdio_mcp',
      'unknown_mcp_filters_rejected_before_api',
      'changed_cursor_scope_rejected',
      'malformed_url_recovery',
      'inert_hostile_title',
      'empty_foreign_and_deleted_repository_scope',
      'older_empty_page_recovery',
      'no_writes_from_reads',
    ],
    notice:
      'Only labeled synthetic session metadata in an isolated in-memory database, including a foreign test workspace. No captured commands, user evidence, GitHub service, or AI provider was used.',
  };
  mkdirSync(resolve(root, '.memvora'), { recursive: true });
  writeFileSync(
    resolve(root, '.memvora/directory-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  await Promise.all(children.map(stop));
  await app.close();
}
