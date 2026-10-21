import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { Check } from 'typebox/value';
import {
  SessionNoteResponseSchema,
  SessionNotesPageSchema,
  RecallAnswerSchema,
  SessionHandoverSchema,
} from '../packages/contracts/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { LocalMemvora } from '../packages/core/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';

// Isolated synthetic command metadata tests journal and handover contracts; no user evidence is loaded.
const root = resolve(import.meta.dirname, '..');
const token = randomBytes(32).toString('hex');
const store = new SqliteEvidenceStore(':memory:');
const service = new LocalMemvora(store);
const app = buildApp({ store, token, embeddedWorker: false });
const children = [];
async function unusedPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((done, error) => socket.close((reason) => (reason ? error(reason) : done())));
  return port;
}
async function runCli(args, environment) {
  const child = spawn(process.execPath, [resolve(root, 'apps/cli/dist/index.js'), ...args], {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 2 * 1024 * 1024) child.kill();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 65536) child.kill();
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, 'Compiled journal/handover CLI failed.');
    assert.ok(!stderr.includes(token));
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
  }
}
let mcp;
const pending = new Map();
let rpcId = 0;
let protocolBuffer = '';
let protocolError;
function fail(error) {
  protocolError = error;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
function call(method, params) {
  if (protocolError) return Promise.reject(protocolError);
  const id = ++rpcId;
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out.`));
    }, 15_000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
try {
  const inertAuthorText =
    '<script>globalThis.journalHandoverAuthorFixtureMustRemainInert=true</script>';
  const inertOutputText =
    '<script>globalThis.journalHandoverOutputFixtureMustRemainInert=true</script>';
  function assertNoSecrets(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of [token, 'private-fixture-secret', 'private-fixture-output-secret'])
      assert.ok(!text.includes(secret), 'A credential or unredacted fixture secret was exposed.');
  }
  const repository = service.createRepository({ name: 'Isolated journal acceptance fixture' });
  const session = store.createSession(service.context(), {
    repositoryId: repository.id,
    title: 'Isolated journal fixture, synthetic execution metadata',
  });
  const event = {
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: 1,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    command: { executable: 'synthetic-journal-fixture', args: [], shell: 'not_executed_fixture' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'incomplete', exitCode: null, signal: null },
    capture: { complete: false, truncatedBytes: 0, redacted: true },
    output: [
      {
        stream: 'stderr',
        ordinal: 0,
        text: `HandoverAcceptanceOutputMarker: labeled synthetic output, not an executed command. ${inertOutputText}\npassword=private-fixture-output-secret`,
      },
    ],
    diffs: [],
  };
  service.ingest([event]);
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const webPort = await unusedPort();
  const web = `http://127.0.0.1:${webPort}`;
  const environment = { ...process.env, MEMVORA_API_URL: api, MEMVORA_LOCAL_TOKEN: token };
  // Never inherit a real GitHub App or AI provider into this no-network fixture.
  for (const key of Object.keys(environment))
    if (key.startsWith('GITHUB_') || key.startsWith('MEMVORA_AI_')) delete environment[key];
  const website = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    {
      cwd: resolve(root, 'apps/web'),
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(website);
  website.stdout.resume();
  website.stderr.resume();
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (website.exitCode !== null)
      throw new Error('Compiled journal website exited before startup.');
    try {
      const response = await fetch(`${web}/api/status`, {
        redirect: 'error',
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* The isolated server may not be listening yet. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, 'Compiled journal website did not become ready.');
  async function request(
    origin,
    path,
    { body, expected = 200, originHeader, authenticated = false } = {},
  ) {
    const response = await fetch(new URL(path, origin), {
      redirect: 'error',
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(originHeader ? { origin: originHeader } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(
      response.status,
      expected,
      `Journal boundary returned HTTP ${response.status}, expected ${expected}.`,
    );
    return response.json();
  }
  const id = randomUUID();
  const input = {
    id,
    kind: 'decision',
    body: `JournalAcceptanceMarker: this is an explicit test author statement. pass\u0000word=private-fixture-secret\n${inertAuthorText}`,
    eventIds: [event.eventId],
  };
  const path = `/api/sessions/${session.id}/notes`;
  await request(web, path, { body: input, expected: 403 });
  await request(web, path, { body: input, originHeader: 'https://hostile.invalid', expected: 403 });
  const created = await request(web, path, { body: input, originHeader: web, expected: 201 });
  assert.ok(Check(SessionNoteResponseSchema, created));
  assert.ok(!JSON.stringify(created).includes('private-fixture-secret'));
  assert.equal(created.note.author.id, service.context().user.id);
  assert.equal(created.note.sources[0].id, event.eventId);
  assert.deepEqual(
    await request(web, path, { body: input, originHeader: web, expected: 200 }),
    created,
  );
  await request(web, path, {
    body: { ...input, body: 'A changed report' },
    originHeader: web,
    expected: 409,
  });
  await request(web, path, {
    body: { ...input, id: randomUUID(), eventIds: [randomUUID()] },
    originHeader: web,
    expected: 404,
  });
  const retryId = randomUUID();
  const cliArgs = [
    'session',
    'note',
    session.id,
    '--text',
    'JournalAcceptanceMarker: submitted through the compiled CLI; no verified outcome is asserted.',
    '--kind',
    'note',
    '--event',
    event.eventId,
    '--note-id',
    retryId,
  ];
  const cliCreated = await runCli(cliArgs, environment);
  assert.ok(Check(SessionNoteResponseSchema, cliCreated));
  assert.deepEqual(await runCli(cliArgs, environment), cliCreated);
  const page = await runCli(['session', 'notes', session.id, '--limit', '1'], environment);
  assert.ok(Check(SessionNotesPageSchema, page));
  assert.equal(page.totalNotes, 2);
  assert.ok(page.olderBeforeId);
  const older = await runCli(
    ['session', 'notes', session.id, '--limit', '1', '--before', page.olderBeforeId],
    environment,
  );
  assert.equal(older.items[0].id, id);
  const answer = await request(api, '/v1/ask', {
    body: { query: 'JournalAcceptanceMarker', repositoryIds: [repository.id] },
    authenticated: true,
  });
  assert.ok(Check(RecallAnswerSchema, answer));
  assert.ok(answer.label.includes('User-authored notes (unverified)'));
  assert.ok(answer.sources.some((source) => source.id === id && source.kind === 'session_note'));
  assert.ok(answer.uncertainty.some((item) => item.includes('user-authored statements')));
  const html = await fetch(`${web}/notes/${id}`, { signal: AbortSignal.timeout(15_000) }).then(
    (response) => {
      assert.equal(response.status, 200);
      return response.text();
    },
  );
  assert.ok(html.includes('JournalAcceptanceMarker'));
  assert.ok(html.includes('not independently verified'));
  assert.ok(!html.includes(token));
  assert.ok(!html.includes('private-fixture-secret'));
  mcp = spawn(process.execPath, [resolve(root, 'apps/mcp/dist/index.js')], {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(mcp);
  mcp.stderr.resume();
  mcp.stdout.on('data', (chunk) => {
    protocolBuffer += chunk;
    if (protocolBuffer.length > 2 * 1024 * 1024)
      return fail(new Error('MCP protocol buffer exceeded.'));
    while (protocolBuffer.includes('\n')) {
      const end = protocolBuffer.indexOf('\n');
      const line = protocolBuffer.slice(0, end);
      protocolBuffer = protocolBuffer.slice(end + 1);
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
  mcp.on('error', () => fail(new Error('MCP process failed.')));
  mcp.on('exit', () => {
    if (pending.size) fail(new Error('MCP exited before completing a request.'));
  });
  await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'memvora-journal-acceptance', version: '1.0.0' },
  });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await call('tools/list', {});
  for (const name of [
    'get_session_notes',
    'get_session_note',
    'search_session_notes',
    'get_session_handover',
  ])
    assert.ok(list.tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint));
  async function tool(name, args) {
    const result = await call('tools/call', { name, arguments: args });
    assert.ok(!result.isError, 'Journal MCP tool failed.');
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 96 * 1024);
    return JSON.parse(result.content[0].text);
  }
  const context = await tool('get_session_notes', { id: session.id, limit: 1 });
  assert.equal(context.items[0].id, retryId);
  assert.equal(context.olderBeforeId, page.olderBeforeId);
  const detail = await tool('get_session_note', { id });
  assert.equal(detail.note.id, id);
  assert.deepEqual(detail.note.sources, created.note.sources);
  const search = await tool('search_session_notes', {
    query: 'JournalAcceptanceMarker',
    repositoryIds: [repository.id],
    limit: 5,
  });
  assert.equal(search.items.length, 2);
  const empty = await tool('search_session_notes', {
    query: 'JournalAcceptanceMarker',
    repositoryIds: [],
    limit: 5,
  });
  assert.deepEqual(empty.items, []);

  // Reuse these live transports to prove the portable report remains a read-only projection.
  const beforeHandover = store.dashboard(service.context());
  const beforeJournal = store.sessionNotes(service.context(), session.id, { limit: 50 });
  const handoverPath = `/v1/sessions/${session.id}/handover`;
  const downloadPath = `/api/sessions/${session.id}/handover`;
  await request(api, handoverPath, { expected: 401 });
  await request(api, `${handoverPath}/download?format=json`, { expected: 401 });
  const handover = await request(api, handoverPath, { authenticated: true });
  assert.ok(Check(SessionHandoverSchema, handover));
  assert.equal(handover.session.id, session.id);
  assert.equal(handover.repository.id, repository.id);
  assert.deepEqual(
    handover.events.map((item) => item.eventId),
    [event.eventId],
  );
  assert.deepEqual(new Set(handover.notes.map((note) => note.id)), new Set([id, retryId]));
  assert.equal(handover.coverage.totalEvents, 1);
  assert.equal(handover.coverage.includedEvents, 1);
  assert.equal(handover.coverage.omittedEvents, 0);
  assert.equal(handover.coverage.totalNotes, 2);
  assert.equal(handover.coverage.includedNotes, 2);
  assert.equal(handover.coverage.omittedNotes, 0);
  assert.equal(handover.coverage.repositoryFilesIncluded, false);
  assert.equal(handover.coverage.derivedMemoriesIncluded, false);
  assert.ok(Buffer.byteLength(JSON.stringify(handover), 'utf8') <= handover.serializedByteLimit);
  const includedEventIds = new Set(handover.events.map((item) => item.eventId));
  for (const source of [
    ...handover.recap.sources,
    ...handover.notes.flatMap((note) => note.sources),
  ]) {
    assert.equal(source.kind, 'event');
    assert.equal(source.repositoryId, repository.id);
    assert.ok(includedEventIds.has(source.id), 'A handover citation has no included event.');
  }
  for (const step of handover.recap.steps) assert.ok(includedEventIds.has(step.eventId));
  for (const item of [...handover.events, ...handover.notes]) {
    assert.equal(item.repositoryId, repository.id);
    assert.equal(item.sessionId, session.id);
  }
  assertNoSecrets(handover);

  const handoverHtml = await fetch(`${web}/sessions/${session.id}/handover`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).then((response) => {
    assert.equal(response.status, 200);
    return response.text();
  });
  for (const marker of [
    'Investigation handover',
    'Portable report coverage',
    'JournalAcceptanceMarker',
    'HandoverAcceptanceOutputMarker',
    'Download Markdown',
    'Download JSON',
  ])
    assert.ok(handoverHtml.includes(marker));
  assert.ok(handoverHtml.includes('not independently verified'));
  assert.ok(
    handoverHtml.includes(
      '&lt;script&gt;globalThis.journalHandoverAuthorFixtureMustRemainInert=true&lt;/script&gt;',
    ),
  );
  assert.ok(
    handoverHtml.includes(
      '&lt;script&gt;globalThis.journalHandoverOutputFixtureMustRemainInert=true&lt;/script&gt;',
    ),
  );
  assert.ok(!handoverHtml.includes(inertAuthorText));
  assert.ok(!handoverHtml.includes(inertOutputText));
  assert.ok(handoverHtml.includes(`/events/${event.eventId}`));
  assert.ok(handoverHtml.includes(`/notes/${id}`));
  assertNoSecrets(handoverHtml);

  for (const format of ['json', 'markdown']) {
    const response = await fetch(`${web}${downloadPath}?format=${format}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="memvora-handover-${session.id}.${format === 'json' ? 'json' : 'md'}"`,
    );
    assert.equal(
      response.headers.get('content-type'),
      `${format === 'json' ? 'application/json' : 'text/markdown'}; charset=utf-8`,
    );
    assert.match(response.headers.get('cache-control') ?? '', /no-store/u);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const content = await response.text();
    assertNoSecrets(content);
    if (format === 'json') {
      const downloaded = JSON.parse(content);
      assert.ok(Check(SessionHandoverSchema, downloaded));
      assert.equal(downloaded.session.id, session.id);
      assert.deepEqual(downloaded.coverage, handover.coverage);
      assert.deepEqual(
        downloaded.events.map((item) => item.eventId),
        handover.events.map((item) => item.eventId),
      );
    } else {
      assert.ok(content.includes('JournalAcceptanceMarker'));
      assert.ok(content.includes('HandoverAcceptanceOutputMarker'));
      assert.ok(content.includes(session.id));
    }
  }
  for (const suffix of ['?format=html', '?format=json&format=markdown', '?format=json&extra=true'])
    await request(web, `${downloadPath}${suffix}`, { expected: 400 });
  await request(web, '/api/sessions/not-a-uuid/handover?format=json', { expected: 400 });

  const cliHandover = await runCli(
    ['session', 'export', session.id, '--format', 'json'],
    environment,
  );
  assert.ok(Check(SessionHandoverSchema, cliHandover));
  assert.equal(cliHandover.session.id, session.id);
  assert.deepEqual(cliHandover.coverage, handover.coverage);
  assert.deepEqual(
    cliHandover.events.map((item) => item.eventId),
    handover.events.map((item) => item.eventId),
  );
  assert.deepEqual(
    cliHandover.notes.map((note) => note.id),
    handover.notes.map((note) => note.id),
  );
  assertNoSecrets(cliHandover);

  const preview = await tool('get_session_handover', { id: session.id });
  assert.equal(preview.fullReportIncluded, false);
  assert.equal(preview.session.id, session.id);
  assert.equal(preview.repository.id, repository.id);
  assert.deepEqual(preview.coverage, handover.coverage);
  assert.deepEqual(
    preview.events.map((item) => item.eventId),
    handover.events.map((item) => item.eventId),
  );
  assert.deepEqual(
    preview.notes.map((note) => note.id),
    handover.notes.map((note) => note.id),
  );
  assert.deepEqual(
    preview.recap.eventIds,
    handover.recap.steps.map((step) => step.eventId),
  );
  assert.deepEqual(preview.recap.sources, handover.recap.sources);
  for (const note of preview.notes)
    assert.deepEqual(note.sources, handover.notes.find((item) => item.id === note.id).sources);
  assert.equal(preview.outputExcerptsIncluded, false);
  assert.equal(preview.diffTextIncluded, false);
  assert.equal(preview.excerpted, true);
  assert.ok(preview.events.every((item) => !('outputExcerpt' in item) && !('diffs' in item)));
  assert.equal(preview.fullReportDownload.json, `${handoverPath}/download?format=json`);
  assert.equal(preview.fullReportDownload.markdown, `${handoverPath}/download?format=markdown`);
  assert.ok(preview.fullReportDownload.cli.includes(session.id));
  assert.ok(preview.fullReportDownload.cli.includes('session export'));
  assertNoSecrets(preview);
  assert.deepEqual(
    store.dashboard(service.context()),
    beforeHandover,
    'Handover reads changed evidence, memory, or job state.',
  );
  assert.deepEqual(
    store.sessionNotes(service.context(), session.id, { limit: 50 }),
    beforeJournal,
    'Handover reads changed author reports.',
  );

  store.deleteSession(service.context(), session.id);
  await request(api, `/v1/session-notes/${id}`, { expected: 404, authenticated: true });
  for (const path of [
    handoverPath,
    `${handoverPath}/download?format=json`,
    `${handoverPath}/download?format=markdown`,
  ]) {
    const deleted = await request(api, path, { expected: 404, authenticated: true });
    assert.ok(!('events' in deleted) && !('content' in deleted));
    assert.ok(!JSON.stringify(deleted).includes('JournalAcceptanceMarker'));
    assertNoSecrets(deleted);
  }
  for (const format of ['json', 'markdown']) {
    const deleted = await fetch(`${web}${downloadPath}?format=${format}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(deleted.status, 404);
    assert.equal(deleted.headers.get('content-disposition'), null);
    const body = await deleted.text();
    assert.ok(!body.includes('JournalAcceptanceMarker'));
    assert.ok(!body.includes('HandoverAcceptanceOutputMarker'));
    assertNoSecrets(body);
  }
  const deletedPreview = await call('tools/call', {
    name: 'get_session_handover',
    arguments: { id: session.id },
  });
  assert.equal(deletedPreview.isError, true);
  assert.ok(!JSON.stringify(deletedPreview).includes('JournalAcceptanceMarker'));
  assertNoSecrets(deletedPreview);
  const report = {
    completedAt: new Date().toISOString(),
    mode: 'isolated_synthetic_journal_handover_fixture',
    checks: [
      'browser_same_origin',
      'redaction',
      'uuid_retries',
      'immutable_conflict',
      'source_scope',
      'compiled_cli_write_and_pages',
      'ask_author_citations',
      'compiled_note_page',
      'real_mcp_stdio',
      'handover_consistent_projection_and_citation_closure',
      'compiled_handover_page_inert_content',
      'handover_download_attachments_and_boundaries',
      'compiled_cli_full_json_handover',
      'mcp_read_only_handover_preview',
      'handover_reads_do_not_write',
      'parent_deletion',
      'deleted_handover_and_downloads_denied',
    ],
    notice:
      'In-memory isolated store and labeled synthetic execution metadata. No user evidence, GitHub service or AI provider was loaded or modified.',
  };
  mkdirSync(resolve(root, '.memvora'), { recursive: true });
  writeFileSync(
    resolve(root, '.memvora/journal-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  for (const child of children) {
    child.stdin?.end();
    if (child.exitCode === null) child.kill();
  }
  await app.close();
}
