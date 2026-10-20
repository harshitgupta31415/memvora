import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Check } from 'typebox/value';
import { SessionEventsPageSchema } from '../packages/contracts/dist/index.js';

// Inspect existing captured evidence; do not seed events or fabricated recall answers.
const projectRoot = resolve(import.meta.dirname, '..');
const dataDir = resolve(process.env.MEMVORA_DATA_DIR ?? resolve(projectRoot, '.memvora'));
const api = new URL(process.env.MEMVORA_API_URL ?? 'http://127.0.0.1:4000');
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) ||
  !['http:', 'https:'].includes(api.protocol) ||
  api.username ||
  api.password ||
  api.search ||
  api.hash
)
  throw new Error('History acceptance requires a plain loopback API origin.');
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
  assert.equal(response.status, expected, `History request returned HTTP ${response.status}`);
  return response.json();
}
const sessions = (await request('/v1/sessions?limit=100')).items;
const session = sessions.find(
  (item) =>
    item.eventCount >= 3 &&
    (!process.env.MEMVORA_ACCEPTANCE_SESSION_ID ||
      item.id === process.env.MEMVORA_ACCEPTANCE_SESSION_ID),
);
assert.ok(
  session,
  'Capture at least three commands in an investigation before history acceptance.',
);
const pagePath = (cursor) =>
  `/v1/sessions/${session.id}/events?${new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) })}`;
const latest = await request(pagePath());
assert.ok(Check(SessionEventsPageSchema, latest));
assert.equal(latest.events.length, 1);
assert.equal(latest.page.newerCursor, null);
assert.ok(latest.page.olderCursor);
const earlier = await request(pagePath(latest.page.olderCursor));
assert.ok(Check(SessionEventsPageSchema, earlier));
assert.equal(earlier.events.length, 1);
assert.ok(earlier.events[0].sequence < latest.events[0].sequence);
assert.equal(earlier.page.snapshotEventCount, latest.page.snapshotEventCount);
const roundTrip = await request(pagePath(earlier.page.newerCursor));
assert.deepEqual(roundTrip.events, latest.events);
for (const page of [latest, earlier, roundTrip]) {
  const ids = new Set(page.events.map((event) => event.eventId));
  assert.ok(
    page.memories.every((memory) => ids.has(memory.id)),
    "Only this page's linked summaries may be returned.",
  );
}
await request(pagePath('invalid-cursor'), 400);
await request(`/v1/sessions/${session.id}/events?limit=51`, 400);
function cliPage(cursor) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(projectRoot, 'apps/cli/dist/index.js'),
      'session',
      'show',
      session.id,
      '--limit',
      '1',
      ...(cursor ? ['--cursor', cursor] : []),
    ],
    {
      cwd: projectRoot,
      env: environment,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'CLI history did not complete.');
  const page = JSON.parse(result.stdout);
  assert.ok(Check(SessionEventsPageSchema, page));
  return page;
}
assert.ok(earlier.page.newerCursor);
assert.deepEqual(cliPage(earlier.page.newerCursor).events, latest.events);
assert.deepEqual(cliPage(latest.page.olderCursor).events, earlier.events);

const child = spawn(process.execPath, [resolve(projectRoot, 'apps/mcp/dist/index.js')], {
  cwd: projectRoot,
  env: environment,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 0;
let buffer = '';
let protocolError;
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
  if (buffer.length > 2 * 1024 * 1024)
    return fail(new Error('MCP stdout exceeded the protocol buffer limit.'));
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fail(new Error('MCP stdout was not protocol-only.'));
      return;
    }
    const waiter = pending.get(value.id);
    if (waiter) {
      pending.delete(value.id);
      clearTimeout(waiter.timer);
      if (value.error) waiter.reject(new Error('MCP request failed.'));
      else waiter.resolve(value.result);
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
async function mcpPage(cursor) {
  const result = await call('tools/call', {
    name: 'get_session_context',
    arguments: { id: session.id, limit: 1, ...(cursor ? { cursor } : {}) },
  });
  assert.ok(!result.isError, 'MCP history tool returned an error.');
  return JSON.parse(result.content[0].text);
}
try {
  await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'memvora-history-acceptance', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await call('tools/list', {});
  assert.ok(
    list.tools.some(
      (tool) =>
        tool.name === 'get_session_context' &&
        tool.inputSchema.properties.cursor &&
        tool.annotations?.readOnlyHint,
    ),
  );
  const current = await mcpPage(earlier.page.newerCursor);
  assert.equal(current.events[0].eventId, latest.events[0].eventId);
  const previous = await mcpPage(current.page.olderCursor);
  assert.equal(previous.events[0].eventId, earlier.events[0].eventId);
  const next = await mcpPage(previous.page.newerCursor);
  assert.equal(next.events[0].eventId, latest.events[0].eventId);
  assert.ok(previous.events.every((event) => event.excerpted === true));
  assert.ok(previous.memories.every((memory) => memory.id === previous.events[0].eventId));
  const denied = await call('tools/call', {
    name: 'get_session_context',
    arguments: { id: session.id, cursor: 'invalid-cursor' },
  });
  assert.equal(denied.isError, true);
  assert.ifError(protocolError);
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  child.stdin.end();
  child.kill();
}
const report = {
  completedAt: new Date().toISOString(),
  sessionId: session.id,
  eventIds: [earlier.events[0].eventId, latest.events[0].eventId],
  snapshotEventCount: latest.page.snapshotEventCount,
  checks: {
    apiEarlierLater: true,
    linkedSummaries: true,
    invalidCursor: true,
    boundedLimit: true,
    cliSameSnapshot: true,
    cliEarlier: true,
    mcpEarlierLater: true,
    mcpRejectedCursor: true,
    protocolStdout: true,
  },
  notice:
    'Read existing captured commands through API, CLI and MCP. No evidence or answer was seeded and no AI provider was called.',
};
writeFileSync(resolve(dataDir, 'history-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
