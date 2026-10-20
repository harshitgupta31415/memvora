import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Check } from 'typebox/value';
import { SessionRecapSchema } from '../packages/contracts/dist/index.js';

// Read existing captured evidence only. No sample recap or answer is inserted.
const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(process.env.MEMVORA_DATA_DIR ?? resolve(root, '.memvora'));
const api = new URL(process.env.MEMVORA_API_URL ?? 'http://127.0.0.1:4000');
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) ||
  !['http:', 'https:'].includes(api.protocol) ||
  api.username ||
  api.password ||
  api.search ||
  api.hash
)
  throw new Error('Recap acceptance requires a plain loopback API origin.');
const token =
  process.env.MEMVORA_LOCAL_TOKEN ?? readFileSync(resolve(dataDir, 'local-token'), 'utf8').trim();
const environment = {
  ...process.env,
  MEMVORA_API_URL: api.origin,
  MEMVORA_DATA_DIR: dataDir,
  MEMVORA_LOCAL_TOKEN: token,
};
async function request(path, expected = 200) {
  const response = await fetch(new URL(path, api), {
    redirect: 'error',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, `Recap request returned HTTP ${response.status}`);
  return response.json();
}
const before = await request('/v1/dashboard');
const sessions = (await request('/v1/sessions?limit=100')).items;
const session = sessions.find(
  (item) =>
    item.eventCount >= 3 &&
    (!process.env.MEMVORA_ACCEPTANCE_SESSION_ID ||
      item.id === process.env.MEMVORA_ACCEPTANCE_SESSION_ID),
);
assert.ok(session, 'Capture at least three commands before running recap acceptance.');
const recap = await request(`/v1/sessions/${session.id}/recap`);
assert.ok(Check(SessionRecapSchema, recap));
assert.equal(recap.mode, 'observed');
assert.equal(recap.coverage.totalEvents, session.eventCount);
assert.equal(recap.steps.length, recap.coverage.includedEvents);
assert.deepEqual(
  recap.steps.map((step) => step.eventId),
  recap.sources.map((source) => source.id),
);
for (const step of recap.steps) {
  const { event } = await request(`/v1/events/${step.eventId}`);
  assert.equal(event.sessionId, session.id);
  assert.equal(event.sequence, step.sequence);
  assert.equal(event.repositoryId, session.repositoryId);
}
await request(`/v1/sessions/${session.id}/recap?includeAll=true`, 400);
const cli = spawnSync(
  process.execPath,
  [resolve(root, 'apps/cli/dist/index.js'), 'session', 'recap', session.id, '--json'],
  {
    cwd: root,
    env: environment,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  },
);
assert.ifError(cli.error);
assert.equal(cli.status, 0, 'Compiled CLI recap failed.');
const cliRecap = JSON.parse(cli.stdout);
assert.ok(Check(SessionRecapSchema, cliRecap));
assert.deepEqual(cliRecap.steps, recap.steps);
assert.deepEqual(cliRecap.coverage, recap.coverage);
assert.deepEqual(cliRecap.counts, recap.counts);

const child = spawn(process.execPath, [resolve(root, 'apps/mcp/dist/index.js')], {
  cwd: root,
  env: environment,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = '';
let nextId = 0;
let protocolError;
const pending = new Map();
function fail(error) {
  protocolError = error;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  if (buffer.length > 2 * 1024 * 1024) return fail(new Error('MCP protocol buffer exceeded.'));
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      return fail(new Error('MCP stdout was not protocol-only.'));
    }
    const waiter = pending.get(result.id);
    if (waiter) {
      pending.delete(result.id);
      clearTimeout(waiter.timer);
      if (result.error) waiter.reject(new Error('MCP request failed.'));
      else waiter.resolve(result.result);
    }
  }
});
child.stderr.on('data', () => {});
child.on('error', () => fail(new Error('MCP process failed.')));
child.on('exit', () => {
  if (pending.size) fail(new Error('MCP exited before completing a request.'));
});
function call(method, params) {
  if (protocolError) return Promise.reject(protocolError);
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
let mcpBytes;
try {
  await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'memvora-recap-acceptance', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await call('tools/list', {});
  assert.ok(
    list.tools.some((tool) => tool.name === 'get_session_recap' && tool.annotations?.readOnlyHint),
  );
  const result = await call('tools/call', {
    name: 'get_session_recap',
    arguments: { id: session.id },
  });
  assert.ok(!result.isError, 'MCP recap tool returned an error.');
  mcpBytes = Buffer.byteLength(result.content[0].text, 'utf8');
  assert.ok(mcpBytes <= 128 * 1024);
  const mcp = JSON.parse(result.content[0].text);
  assert.deepEqual(mcp.coverage, recap.coverage);
  assert.deepEqual(mcp.counts, recap.counts);
  assert.deepEqual(
    mcp.steps.map((step) => step.eventId),
    recap.steps.map((step) => step.eventId),
  );
  assert.deepEqual(mcp.sources, recap.sources);
} finally {
  child.stdin.end();
  child.kill();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
}
const after = await request('/v1/dashboard');
assert.deepEqual(
  after.counts,
  before.counts,
  'Recap must not mutate evidence or processing state.',
);
writeFileSync(
  resolve(dataDir, 'recap-acceptance.json'),
  `${JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      sessionId: session.id,
      mode: recap.mode,
      coverage: recap.coverage,
      counts: recap.counts,
      sourceIds: recap.sources.map((source) => source.id),
      checks: [
        'authenticated_api',
        'original_event_citations',
        'compiled_cli_json',
        'real_mcp_stdio',
        'read_only',
      ],
      mcpBytes,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Investigation recap acceptance passed: ${recap.steps.length} cited events, API/CLI/MCP agree; evidence unchanged.`,
);
