import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read actual imported evidence. This acceptance check seeds no files or recall answers.
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
  throw new Error('Source acceptance requires a plain loopback API origin.');
const token =
  process.env.MEMVORA_LOCAL_TOKEN ?? readFileSync(resolve(dataDir, 'local-token'), 'utf8').trim();

async function request(path, body, expected = 200) {
  const response = await fetch(new URL(path, api), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, `${path} returned HTTP ${response.status}`);
  return response.json();
}

const { items: repositories } = await request('/v1/repositories');
let selected;
for (const repository of repositories) {
  if (
    process.env.MEMVORA_ACCEPTANCE_REPOSITORY_ID &&
    repository.id !== process.env.MEMVORA_ACCEPTANCE_REPOSITORY_ID
  )
    continue;
  const { context } = await request(`/v1/repositories/${repository.id}/context`);
  if (context?.files.some((file) => file.sourceId)) {
    selected = { repository, context };
    break;
  }
}
assert.ok(selected, 'Import a GitHub repository before running source acceptance.');
const symbol = selected.context.files
  .filter((file) => /\.(py|ts|tsx|js|jsx|mjs|cjs|rs|go|java|sql)$/iu.test(file.path))
  .map(
    (file) =>
      file.text.match(/\b(?:def|function|class)\s+([A-Za-z_][A-Za-z0-9_]{5,})/u)?.[1] ??
      file.text.match(/\b([A-Za-z_][A-Za-z0-9_]{5,})\s*\(/u)?.[1],
  )
  .find(Boolean);
const query = symbol ?? 'memvora';
const search = await request('/v1/repository-sources/search', {
  query,
  repositoryIds: [selected.repository.id],
  limit: 3,
});
assert.ok(search.items.length, 'Expected the actual imported symbol to be searchable.');
const first = search.items[0];
const answer = await request('/v1/ask', { query, repositoryIds: [selected.repository.id] });
assert.equal(answer.status, 'answered');
const citation = answer.sources.find(
  (source) => source.kind === 'repository_file' && source.id === first.source.id,
);
assert.ok(citation, 'Ask must cite the same immutable imported file.');
const citedIds = new Set(answer.sources.map((source) => source.id));
assert.ok(answer.steps.every((step) => step.sourceIds.every((id) => citedIds.has(id))));
const detail = await request(citation.locator);
assert.equal(detail.document.source.contentHash, citation.contentHash);
assert.equal(detail.document.source.path, citation.path);
assert.equal(detail.document.startLine, citation.startLine);
assert.deepEqual(
  (await request('/v1/repository-sources/search', { query, repositoryIds: [] })).items,
  [],
);
await request(`/v1/repository-sources/${randomUUID()}`, undefined, 404);
assert.equal(
  (await request('/v1/ask', { query: `unrecorded_source_${randomUUID().replaceAll('-', '')}` }))
    .status,
  'insufficient_evidence',
);

const environment = {
  ...process.env,
  MEMVORA_API_URL: api.origin,
  MEMVORA_DATA_DIR: dataDir,
  MEMVORA_LOCAL_TOKEN: token,
};
const cli = spawnSync(
  process.execPath,
  [
    resolve(projectRoot, 'apps/cli/dist/index.js'),
    'ask',
    query,
    '--repository',
    selected.repository.id,
  ],
  {
    cwd: projectRoot,
    env: environment,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  },
);
assert.ifError(cli.error);
assert.equal(cli.status, 0, 'CLI Ask did not complete.');
assert.ok(
  cli.stdout.includes('/v1/repository-sources/'),
  'CLI must expose resolvable file citations.',
);

const child = spawn(process.execPath, [resolve(projectRoot, 'apps/mcp/dist/index.js')], {
  cwd: projectRoot,
  env: environment,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 0;
let buffer = '';
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
      for (const waiter of pending.values())
        waiter.reject(new Error('MCP stdout was not protocol-only.'));
      continue;
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
child.on('error', () => {
  for (const waiter of pending.values()) waiter.reject(new Error('MCP process failed.'));
});
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
    clientInfo: { name: 'memvora-source-acceptance', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await call('tools/list', {});
  for (const name of ['search_repository_sources', 'get_repository_source'])
    assert.ok(
      list.tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint === true),
    );
  const searchTool = await call('tools/call', {
    name: 'search_repository_sources',
    arguments: { query, repositoryIds: [selected.repository.id], limit: 2 },
  });
  assert.ok(!searchTool.isError);
  const hits = JSON.parse(searchTool.content[0].text).items;
  assert.ok(hits.some((hit) => hit.source.id === first.source.id));
  const sourceTool = await call('tools/call', {
    name: 'get_repository_source',
    arguments: { id: first.source.id, startLine: first.startLine, limit: 20 },
  });
  assert.ok(!sourceTool.isError);
  assert.equal(
    JSON.parse(sourceTool.content[0].text).document.source.contentHash,
    first.source.contentHash,
  );
  const emptyTool = await call('tools/call', {
    name: 'search_repository_sources',
    arguments: { query, repositoryIds: [] },
  });
  assert.ok(!emptyTool.isError);
  assert.deepEqual(JSON.parse(emptyTool.content[0].text).items, []);
  const deniedTool = await call('tools/call', {
    name: 'get_repository_source',
    arguments: { id: randomUUID() },
  });
  assert.equal(deniedTool.isError, true);
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  child.stdin.end();
  child.kill();
}
const report = {
  completedAt: new Date().toISOString(),
  repositoryId: selected.repository.id,
  query,
  sourceId: first.source.id,
  sourcePath: first.source.path,
  commitSha: first.source.commitSha,
  contentHash: first.source.contentHash,
  checks: {
    sourceSearch: true,
    citedAsk: true,
    sourceDetail: true,
    emptyScope: true,
    deniedSource: true,
    insufficientEvidence: true,
    cli: true,
    mcpSearch: true,
    mcpDetail: true,
    mcpScope: true,
    protocolStdout: true,
  },
  notice:
    'Read actual stored imported evidence. No source file or recall answer was seeded by this check. No AI provider was called.',
};
writeFileSync(
  resolve(dataDir, 'source-recall-acceptance.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
