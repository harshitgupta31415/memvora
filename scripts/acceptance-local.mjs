import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const dataDir = process.env.MEMVORA_DATA_DIR ?? resolve(projectRoot, '.memvora');
const api = process.env.MEMVORA_API_URL ?? 'http://127.0.0.1:4000';
const apiUrl = new URL(api);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname))
  throw new Error('Local acceptance requires a loopback API.');
const token =
  process.env.MEMVORA_LOCAL_TOKEN ?? readFileSync(resolve(dataDir, 'local-token'), 'utf8').trim();
const runId = randomUUID();
const labRoot = resolve(dataDir, 'labs', runId);
mkdirSync(labRoot, { recursive: true });

async function request(path, body) {
  const response = await fetch(new URL(path, api), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  assert.ok(response.ok, `${path} failed with HTTP ${response.status}`);
  return value;
}

function run(executable, args, cwd, expected = 0) {
  const result = spawnSync(executable, args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expected,
    `${executable} returned ${result.status}; expected ${expected}. ${result.stderr ?? ''}`,
  );
  return result;
}

const cli = (cwd, args, expected) =>
  run(process.execPath, [resolve(projectRoot, 'apps/cli/dist/index.js'), ...args], cwd, expected);

async function lab(name, initial, fixed, check, query) {
  const cwd = resolve(labRoot, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(resolve(cwd, '.gitignore'), '.memvora/\n');
  writeFileSync(
    resolve(cwd, 'package.json'),
    JSON.stringify(
      {
        name: `memvora-local-lab-${name}`,
        private: true,
        type: 'module',
        scripts: { check: 'node check.mjs' },
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(cwd, 'subject.mjs'), initial);
  writeFileSync(resolve(cwd, 'check.mjs'), check);
  run('git', ['init', '-b', 'harshitgupta31415/local-acceptance'], cwd);
  run('git', ['add', '.'], cwd);
  run('git', ['commit', '-m', `Add ${name} local acceptance fixture`], cwd);
  const registered = await request('/v1/repositories', {
    name: `Local lab: ${name}`,
    localPath: cwd,
  });
  cli(cwd, ['init', '--repository-id', registered.repository.id]);
  const binding = JSON.parse(readFileSync(resolve(cwd, '.memvora/config.json'), 'utf8'));
  // These are genuine failed/passing executions. No memory response is seeded.
  cli(cwd, ['run', '--', process.execPath, 'check.mjs'], 1);
  writeFileSync(resolve(cwd, 'subject.mjs'), fixed);
  cli(cwd, ['run', '--', process.execPath, 'check.mjs'], 0);
  // The same successful invocation is a distinct execution, not a content-hash duplicate.
  cli(cwd, ['run', '--', process.execPath, 'check.mjs'], 0);
  cli(cwd, ['sync']);
  let context;
  for (let attempt = 0; attempt < 30; attempt++) {
    context = await request(`/v1/sessions/${binding.sessionId}`);
    if (context.memories.length === 3) break;
    await new Promise((done) => setTimeout(done, 400));
  }
  assert.equal(context.events.length, 3);
  assert.equal(context.memories.length, 3);
  assert.equal(new Set(context.events.map((event) => event.eventId)).size, 3);
  assert.equal(context.events[0].outcome.exitCode, 1);
  assert.equal(context.events[1].outcome.exitCode, 0);
  assert.ok(context.events[1].diffs.some((diff) => diff.text.includes('subject.mjs')));
  const answer = await request('/v1/ask', { query, repositoryIds: [binding.repositoryId] });
  assert.equal(answer.status, 'answered');
  assert.ok(answer.sources.length > 0);
  for (const source of answer.sources) assert.equal(source.repositoryId, binding.repositoryId);
  const ack = await request('/v1/events/batch', { schemaVersion: 1, events: [context.events[0]] });
  assert.deepEqual(ack.acknowledgedEventIds, [context.events[0].eventId]);
  assert.equal((await request(`/v1/sessions/${binding.sessionId}`)).events.length, 3);
  const irrelevant = await request('/v1/ask', {
    query: `unknown-${randomUUID()}`,
    repositoryIds: [binding.repositoryId],
  });
  assert.equal(irrelevant.status, 'insufficient_evidence');
  cli(cwd, ['ask', query]);
  cli(cwd, ['session', 'end']);
  return {
    fixture: name,
    directory: cwd,
    repositoryId: binding.repositoryId,
    sessionId: binding.sessionId,
    eventIds: context.events.map((event) => event.eventId),
    memoryId: context.memories[0].id,
    query,
    sourceCount: answer.sources.length,
  };
}

async function mcpCheck(labResult) {
  const child = spawn(process.execPath, [resolve(projectRoot, 'apps/mcp/dist/index.js')], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MEMVORA_API_URL: api, MEMVORA_DATA_DIR: dataDir },
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        for (const item of pending.values()) item.reject(new Error('MCP stdout was not JSON-RPC.'));
        continue;
      }
      if (value.id && pending.has(value.id)) {
        const item = pending.get(value.id);
        pending.delete(value.id);
        clearTimeout(item.timer);
        if (value.error) item.reject(new Error('MCP request failed.'));
        else item.resolve(value.result);
      }
    }
  });
  // Drain diagnostics without storing tokens or transcript payloads in ordinary logs.
  child.stderr.on('data', () => {});
  function call(method, params) {
    const id = ++nextId;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out.`));
      }, 15_000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  try {
    await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'memvora-local-acceptance', version: '1.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const list = await call('tools/list', {});
    for (const name of ['search_memory', 'get_memory', 'get_session_context'])
      assert.ok(
        list.tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint === true),
      );
    const search = await call('tools/call', {
      name: 'search_memory',
      arguments: { query: labResult.query, repositoryIds: [labResult.repositoryId] },
    });
    assert.ok(!search.isError);
    const searchValue = JSON.parse(search.content[0].text);
    assert.ok(searchValue.items.length > 0);
    const memory = await call('tools/call', {
      name: 'get_memory',
      arguments: { id: labResult.memoryId },
    });
    assert.ok(!memory.isError);
    const session = await call('tools/call', {
      name: 'get_session_context',
      arguments: { id: labResult.sessionId },
    });
    assert.ok(!session.isError);
    assert.equal(JSON.parse(session.content[0].text).totalEvents, 3);
    return {
      initialized: true,
      readOnlyTools: 3,
      search: true,
      memory: true,
      session: true,
      protocolStdout: 'clean',
    };
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    child.stdin.end();
    child.kill();
  }
}

const results = [];
results.push(
  await lab(
    'email-normalization',
    'export const normalizeEmail = value => value.toLowerCase();\n',
    'export const normalizeEmail = value => value.trim().toLowerCase();\n',
    "import assert from 'node:assert/strict'; import { normalizeEmail } from './subject.mjs'; assert.equal(normalizeEmail('  USER@EXAMPLE.COM  '), 'user@example.com', 'Email normalization must trim whitespace'); console.log('Email normalization check passed');\n",
    'Email normalization',
  ),
);
results.push(
  await lab(
    'port-validation',
    'export const parsePort = value => Number.parseInt(value, 10);\n',
    "export const parsePort = value => { const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port configuration'); return port; };\n",
    "import assert from 'node:assert/strict'; import { parsePort } from './subject.mjs'; assert.throws(() => parsePort('not-a-port'), /Invalid port configuration/, 'Invalid port configuration must be rejected'); assert.equal(parsePort('4000'), 4000); console.log('Port configuration check passed');\n",
    'Invalid port configuration',
  ),
);
const mcp = await mcpCheck(results[0]);
const report = {
  completedAt: new Date().toISOString(),
  runId,
  notice:
    'Labeled local acceptance fixtures; real commands, failures, edits and passing checks were captured through the product. No answer was seeded.',
  labs: results,
  mcp,
};
writeFileSync(resolve(dataDir, 'local-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
