import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';
import { LocalMemvora } from '../packages/core/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { LocalOutbox } from '../apps/cli/dist/local.js';

// Only isolated synthetic metadata is uploaded to the disposable in-memory API below.
const root = resolve(import.meta.dirname, '..');
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-outbox-'));
const captureRoot = join(fixture, 'captured-repository');
const privateDirectory = join(captureRoot, '.memvora');
const outboxPath = join(privateDirectory, 'outbox.sqlite');
const configurationPath = join(privateDirectory, 'config.json');
const credentialDirectory = join(fixture, 'server-credential');
const absentCredentialDirectory = join(fixture, 'no-credential');
const token = randomBytes(32).toString('hex');
const hiddenArgument = 'SyntheticOutboxPrivateArgument';
const hiddenOutput = 'SyntheticOutboxPrivateOutput';
const store = new SqliteEvidenceStore(':memory:');
const service = new LocalMemvora(store);
const app = buildApp({ store, token, embeddedWorker: false });
const children = new Set();
const childStates = new WeakMap();
const batches = [];
let requests = 0;
let injectLate = false;
let lateEvent;
let outbox;
let origin;
const environment = {
  ...process.env,
  MEMVORA_DATA_DIR: absentCredentialDirectory,
  MEMVORA_API_URL: 'http://127.0.0.1:1',
};
for (const key of Object.keys(environment))
  if (
    key === 'MEMVORA_LOCAL_TOKEN' ||
    key === 'AI_API_KEY' ||
    key.startsWith('GIT_') ||
    key.startsWith('GITHUB_') ||
    key.startsWith('MEMVORA_AI_')
  )
    delete environment[key];
environment.GIT_CEILING_DIRECTORIES = fixture;

function safe(value) {
  for (const secret of [token, hiddenArgument, hiddenOutput])
    assert.ok(!String(value).includes(secret), 'Private fixture content was exposed.');
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function outboxFingerprint() {
  return digest(
    JSON.stringify(
      ['executions', 'sessions', 'output_chunks'].map((table) => [
        table,
        outbox.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );
}
function initial(repositoryId, sessionId) {
  return {
    eventId: randomUUID(),
    repositoryId,
    sessionId,
    startedAt: '2026-10-21T10:00:00.000Z',
    command: {
      executable: 'node',
      args: ['synthetic-recovery.cjs', hiddenArgument],
      shell: 'direct',
    },
    cwd: 'synthetic-repository',
    git: { commitSha: null, dirty: false },
    diffs: [],
  };
}
function enqueue(repositoryId, sessionId, finalized = true) {
  const metadata = initial(repositoryId, sessionId);
  const sequence = outbox.begin(metadata.eventId, sessionId, metadata);
  if (!finalized) return { ...metadata, sequence };
  const captured = {
    ...metadata,
    sequence,
    endedAt: '2026-10-21T10:00:01.000Z',
    outcome: { kind: 'completed', exitCode: sequence % 2, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stdout', ordinal: 0, text: `${hiddenOutput} ${sequence}` }],
  };
  outbox.finalize(captured.eventId, captured);
  return captured;
}
async function waitForClose(state, milliseconds) {
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
  const state = childStates.get(child);
  if (!state) throw new Error('Refusing to stop an unowned outbox acceptance process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitForClose(state, 1000)) return;
      throw new Error('Outbox process cleanup could not be confirmed. Fixture retained.');
    }
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((done) =>
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000 },
            () => done(),
          ),
        );
    } else {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== 'ESRCH')
            throw new Error('Outbox process group cleanup failed. Fixture retained.');
        }
        if (signal === 'SIGTERM') await waitForClose(state, 1000);
      }
    }
    if (!(await waitForClose(state, 3000)))
      throw new Error('Outbox process cleanup could not be confirmed. Fixture retained.');
  })();
  return state.stopping;
}
function requestStop(child) {
  void stop(child).catch(() => {});
}
async function cli(args, { online = false, success = true, cwd = captureRoot, json = true } = {}) {
  const child = spawn(process.execPath, [resolve(root, 'apps/cli/dist/index.js'), ...args], {
    cwd,
    env: online
      ? { ...environment, MEMVORA_API_URL: origin, MEMVORA_DATA_DIR: credentialDirectory }
      : environment,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const completion = once(child, 'close');
  const state = { closed: false, done: undefined, stopping: undefined };
  state.done = new Promise((done) =>
    child.once('close', () => {
      state.closed = true;
      children.delete(child);
      done();
    }),
  );
  childStates.set(child, state);
  let stdout = '';
  let stderr = '';
  let exceeded = false;
  let timedOut = false;
  const collect = (channel) => (chunk) => {
    if (channel === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout + stderr, 'utf8') > 256 * 1024) {
      exceeded = true;
      requestStop(child);
    }
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  const timer = setTimeout(() => {
    timedOut = true;
    requestStop(child);
  }, 40_000);
  try {
    const [code, signal] = await completion;
    assert.equal(timedOut, false, 'Outbox CLI timed out.');
    assert.equal(exceeded, false, 'Outbox CLI exceeded the output budget.');
    assert.equal(signal, null, 'Outbox CLI terminated unexpectedly.');
    safe(stdout);
    safe(stderr);
    if (!success) {
      assert.notEqual(code, 0, 'Invalid outbox operation unexpectedly succeeded.');
      assert.equal(stdout.trim(), '', 'A rejected operation printed a success result.');
      assert.ok(stderr.trim());
      return null;
    }
    assert.equal(code, 0, 'Outbox CLI returned an unexpected failure.');
    return json ? JSON.parse(stdout) : { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
async function inspect(directory, flags = [], success = true) {
  return cli(['outbox', 'list', '--directory', directory, ...flags], { success });
}
function page(value, { sessionId = null, state = 'unsynced', limit = 20 } = {}) {
  assert.equal(value.source, 'local_outbox');
  assert.equal(value.readOnly, true);
  assert.deepEqual(value.filter, { state, sessionId });
  assert.equal(value.page.limit, limit);
  assert.equal(value.page.returnedItems, value.items.length);
  assert.equal(value.page.consistency, 'live');
  assert.ok(value.items.length <= limit);
  assert.ok(value.notice);
  for (let index = 1; index < value.items.length; index++)
    assert.ok(value.items[index].localRowId > value.items[index - 1].localRowId);
  return value;
}

try {
  const context = service.context();
  const repository = service.createRepository({ name: 'Synthetic outbox recovery fixture' });
  const deletedSession = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Deleted fixture',
  });
  const healthySession = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Healthy fixture',
  });
  const exactSession = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Exact-event fixture',
  });
  store.deleteSession(context, deletedSession.id);
  outbox = new LocalOutbox(outboxPath);
  const rejected = [
    enqueue(repository.id, deletedSession.id),
    enqueue(repository.id, deletedSession.id),
  ];
  const healthy = Array.from({ length: 110 }, () => enqueue(repository.id, healthySession.id));
  const exact = enqueue(repository.id, exactSession.id);
  const activeUnfinished = enqueue(repository.id, deletedSession.id, false);
  outbox.db
    .prepare('UPDATE executions SET created_at=? WHERE session_id=?')
    .run('2026-01-01T00:00:00.000Z', deletedSession.id);
  const offlineBefore = outboxFingerprint();
  writeFileSync(configurationPath, '{"corruptBinding":true}\n');
  const corruptBindingBytes = readFileSync(configurationPath);
  assert.equal(existsSync(credentialDirectory), false);

  const first = page(await inspect(captureRoot));
  assert.equal(first.exists, true);
  assert.deepEqual(first.totals, {
    all: 114,
    unsynced: 114,
    pending: 113,
    incomplete: 1,
    synced: 0,
  });
  assert.deepEqual(
    first.items.slice(0, 2).map((item) => item.eventId),
    rejected.map((item) => item.eventId),
  );
  assert.ok(first.items.every((item) => item.metadataValid));
  const discovered = [];
  let after;
  do {
    const selected = page(
      await inspect(captureRoot, [
        '--session',
        healthySession.id,
        '--state',
        'pending',
        '--limit',
        '37',
        ...(after ? ['--after', String(after)] : []),
      ]),
      { sessionId: healthySession.id, state: 'pending', limit: 37 },
    );
    assert.deepEqual(selected.totals, {
      all: 110,
      unsynced: 110,
      pending: 110,
      incomplete: 0,
      synced: 0,
    });
    assert.ok(
      selected.items.every(
        (item) => item.sessionId === healthySession.id && item.repositoryId === repository.id,
      ),
    );
    discovered.push(...selected.items.map((item) => item.eventId));
    after = selected.page.nextAfter;
    assert.ok(discovered.length <= healthy.length);
  } while (after);
  assert.deepEqual(
    discovered,
    healthy.map((item) => item.eventId),
  );
  assert.equal(new Set(discovered).size, healthy.length);
  assert.equal(outboxFingerprint(), offlineBefore);
  assert.deepEqual(readFileSync(configurationPath), corruptBindingBytes);
  assert.equal(
    existsSync(absentCredentialDirectory),
    false,
    'Offline inspection created a credential directory.',
  );

  const missing = join(fixture, 'missing-capture');
  const absent = page(await inspect(missing));
  assert.equal(absent.exists, false);
  assert.deepEqual(absent.totals, { all: 0, unsynced: 0, pending: 0, incomplete: 0, synced: 0 });
  assert.deepEqual(absent.items, []);
  assert.equal(existsSync(missing), false);
  const corruptRoot = join(fixture, 'corrupt-outbox');
  mkdirSync(join(corruptRoot, '.memvora'), { recursive: true });
  const corruptFile = join(corruptRoot, '.memvora', 'outbox.sqlite');
  writeFileSync(corruptFile, `Not SQLite: ${hiddenOutput}`);
  const corruptBytes = readFileSync(corruptFile);
  await inspect(corruptRoot, [], false);
  assert.deepEqual(readFileSync(corruptFile), corruptBytes);
  assert.deepEqual(readdirSync(join(corruptRoot, '.memvora')), ['outbox.sqlite']);

  const legacyRoot = join(fixture, 'legacy-capture');
  mkdirSync(join(legacyRoot, '.memvora'), { recursive: true });
  const legacyFile = join(legacyRoot, '.memvora', 'outbox.sqlite');
  const legacy = new DatabaseSync(legacyFile);
  const legacyMetadata = initial(repository.id, healthySession.id);
  const invalidMetadataId = randomUUID();
  try {
    legacy.exec(
      'PRAGMA journal_mode=DELETE; CREATE TABLE executions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,initial_payload TEXT NOT NULL,payload TEXT,synced INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)',
    );
    const insert = legacy.prepare(
      'INSERT INTO executions(id,session_id,sequence,initial_payload,created_at) VALUES(?,?,?,?,?)',
    );
    insert.run(
      legacyMetadata.eventId,
      healthySession.id,
      1,
      JSON.stringify(legacyMetadata),
      '2026-10-21T10:00:00.000Z',
    );
    insert.run(
      invalidMetadataId,
      healthySession.id,
      2,
      `{ ${hiddenOutput}`,
      '2026-10-21T10:00:01.000Z',
    );
  } finally {
    legacy.close();
  }
  const legacyBytes = readFileSync(legacyFile);
  const legacyPage = page(await inspect(legacyRoot));
  assert.equal(legacyPage.items[0].metadataValid, true);
  assert.equal(legacyPage.items[1].metadataValid, false);
  assert.equal(legacyPage.items[1].eventId, invalidMetadataId);
  assert.equal(legacyPage.items[1].executable, null);
  assert.deepEqual(
    legacyPage.items.map((item) => item.state),
    ['incomplete', 'incomplete'],
  );
  assert.deepEqual(readFileSync(legacyFile), legacyBytes, 'Legacy inspection migrated the outbox.');
  assert.deepEqual(readdirSync(join(legacyRoot, '.memvora')), ['outbox.sqlite']);
  for (const flags of [
    ['--session', 'invalid'],
    ['--limit', '0'],
    ['--limit', '51'],
    ['--after', '0'],
    ['--state', 'unknown'],
  ])
    await inspect(captureRoot, flags, false);
  assert.equal(outboxFingerprint(), offlineBefore);
  assert.equal(requests, 0);

  app.addHook('onRequest', async () => {
    requests++;
  });
  app.addHook('preValidation', async (request) => {
    if (request.method !== 'POST' || request.url !== '/v1/events/batch') return;
    const captured = request.body.events;
    batches.push(captured.map((item) => item.eventId));
    if (injectLate && captured.every((item) => item.sessionId === healthySession.id)) {
      injectLate = false;
      lateEvent = enqueue(repository.id, healthySession.id);
    }
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  mkdirSync(credentialDirectory);
  writeFileSync(join(credentialDirectory, 'local-token'), `${token}\n`, { mode: 0o600 });
  const binding = {
    schemaVersion: 1,
    repositoryId: repository.id,
    sessionId: healthySession.id,
    apiUrl: origin,
  };
  writeFileSync(configurationPath, `${JSON.stringify(binding, null, 4)}\n`);
  const bindingBytes = readFileSync(configurationPath);
  await cli(['sync'], { online: true, success: false });
  assert.equal(
    store.dashboard(context).counts.events,
    0,
    'A rejected mixed batch was partially accepted.',
  );
  assert.equal(outboxFingerprint(), offlineBefore);
  assert.equal(batches.length, 1);
  assert.ok(batches[0].includes(rejected[0].eventId));

  const deadUnfinished = enqueue(repository.id, healthySession.id, false);
  outbox.db
    .prepare('UPDATE executions SET owner_pid=? WHERE id=?')
    .run(2147483647, deadUnfinished.eventId);
  const originalRows = outbox.db
    .prepare(
      'SELECT id,session_id,sequence,initial_payload,payload,owner_pid,created_at FROM executions ORDER BY rowid',
    )
    .all();
  const selectedStart = outbox.lastRowId();
  const postedBefore = batches.length;
  injectLate = true;
  const synced = await cli(['sync', '--session', healthySession.id], { online: true });
  assert.deepEqual(synced.scope, { sessionId: healthySession.id });
  assert.equal(synced.acknowledgedEvents, healthy.length);
  assert.equal(synced.recoveredIncompleteCaptures, 0);
  assert.equal(synced.startedAtRowId, selectedStart);
  assert.equal(synced.stopReason, 'no_eligible_pending');
  assert.deepEqual(synced.remaining, { pending: 1, incomplete: 1 });
  assert.deepEqual(synced.totalRemaining, { pending: 4, incomplete: 2 });
  assert.ok(lateEvent, 'The concurrent capture fixture was not appended.');
  const posted = batches.slice(postedBefore);
  assert.deepEqual(
    posted.map((items) => items.length),
    [50, 50, 10],
  );
  assert.deepEqual(posted.flat().sort(), healthy.map((item) => item.eventId).sort());
  assert.ok(!posted.flat().includes(lateEvent.eventId));
  for (const captured of healthy)
    assert.deepEqual(store.getEvent(context, captured.eventId), captured);
  for (const captured of rejected)
    assert.equal(
      outbox.db.prepare('SELECT synced FROM executions WHERE id=?').get(captured.eventId).synced,
      0,
    );
  const exactResult = await cli(['sync', '--event', exact.eventId], { online: true });
  assert.equal(exactResult.acknowledgedEvents, 1);
  assert.deepEqual(exactResult.scope, { eventId: exact.eventId });
  const postsBeforeRetry = batches.length;
  const retry = await cli(['sync', '--event', exact.eventId], { online: true });
  assert.equal(retry.acknowledgedEvents, 0);
  assert.equal(
    batches.length,
    postsBeforeRetry,
    'Already acknowledged evidence was force-resubmitted.',
  );
  assert.equal(
    (await cli(['sync', '--event', lateEvent.eventId], { online: true })).acknowledgedEvents,
    1,
  );
  const noFinalization = await cli(['sync', '--session', healthySession.id], { online: true });
  assert.deepEqual(noFinalization.remaining, { pending: 0, incomplete: 1 });
  assert.equal(noFinalization.recoveredIncompleteCaptures, 0);
  assert.deepEqual(noFinalization.totalRemaining, { pending: 2, incomplete: 2 });
  assert.equal(store.dashboard(context).counts.events, healthy.length + 2);
  assert.equal(
    store.dashboard(context).counts.memories,
    0,
    'The isolated API unexpectedly processed provider jobs.',
  );
  assert.deepEqual(
    outbox.db
      .prepare(
        'SELECT id,session_id,sequence,initial_payload,payload,owner_pid,created_at FROM executions WHERE id!=? ORDER BY rowid',
      )
      .all(lateEvent.eventId),
    originalRows,
    'Selective sync rewrote captured evidence or sequence metadata.',
  );
  assert.equal(
    outbox.db.prepare('SELECT payload FROM executions WHERE id=?').get(activeUnfinished.eventId)
      .payload,
    null,
  );
  assert.equal(
    outbox.db.prepare('SELECT payload FROM executions WHERE id=?').get(deadUnfinished.eventId)
      .payload,
    null,
  );
  assert.equal(
    outbox.db.prepare('SELECT next_sequence FROM sessions WHERE id=?').get(healthySession.id)
      .next_sequence,
    113,
    'Selective retry changed the capture sequence allocator.',
  );
  assert.equal(
    outbox.db.prepare('SELECT next_sequence FROM sessions WHERE id=?').get(deletedSession.id)
      .next_sequence,
    4,
  );
  assert.deepEqual(readFileSync(configurationPath), bindingBytes);
  const invalidRequestCount = requests;
  await cli(['sync', '--session', 'invalid'], { online: true, success: false });
  await cli(['sync', '--session', healthySession.id, '--event', exact.eventId], {
    online: true,
    success: false,
  });
  assert.equal(requests, invalidRequestCount);
  const finalInspection = page(await inspect(captureRoot));
  assert.deepEqual(finalInspection.totals, {
    all: 116,
    unsynced: 4,
    pending: 2,
    incomplete: 2,
    synced: 112,
  });
  const acknowledged = page(
    await inspect(captureRoot, [
      '--state',
      'synced',
      '--session',
      healthySession.id,
      '--limit',
      '50',
    ]),
    { sessionId: healthySession.id, state: 'synced', limit: 50 },
  );
  assert.deepEqual(acknowledged.totals, {
    all: 112,
    unsynced: 1,
    pending: 0,
    incomplete: 1,
    synced: 111,
  });
  assert.ok(acknowledged.items.every((item) => item.state === 'synced'));
  assert.deepEqual(readFileSync(configurationPath), bindingBytes);

  const freshResponse = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${token}` },
    payload: { repositoryId: repository.id, title: 'Actual tiny command in disposable fixture' },
  });
  assert.equal(freshResponse.statusCode, 201);
  const freshSession = freshResponse.json().session;
  const runBinding = { ...binding, sessionId: freshSession.id };
  // This intentional fixture switch happens after verifying the original binding was untouched.
  writeFileSync(configurationPath, `${JSON.stringify(runBinding, null, 4)}\n`);
  const runBindingBytes = readFileSync(configurationPath);
  const beforeActualRun = outbox.db.prepare('SELECT * FROM executions ORDER BY rowid').all();
  const existingAllocators = outbox.db.prepare('SELECT * FROM sessions ORDER BY id').all();
  const beforeRunBatch = batches.length;
  const actualOutput = 'Memvora disposable outbox execution passed';
  const actualCode = `process.stdout.write('${actualOutput}\\n')`;
  const ran = await cli(['run', '--', process.execPath, '-e', actualCode], {
    online: true,
    json: false,
  });
  assert.equal(ran.stdout, `${actualOutput}\n`);
  const actualSession = store.getSession(context, freshSession.id);
  assert.equal(
    actualSession.events.length,
    1,
    'The actual command was blocked by the old backlog.',
  );
  const actualEvent = actualSession.events[0];
  assert.equal(actualEvent.repositoryId, repository.id);
  assert.equal(actualEvent.sessionId, freshSession.id);
  assert.equal(actualEvent.sequence, 1);
  assert.deepEqual(actualEvent.outcome, { kind: 'completed', exitCode: 0, signal: null });
  assert.equal(actualEvent.command.executable, process.execPath);
  assert.deepEqual(actualEvent.command.args, ['-e', actualCode]);
  assert.equal(actualEvent.command.shell, 'direct');
  assert.equal(actualEvent.output.map((chunk) => chunk.text).join(''), `${actualOutput}\n`);
  assert.deepEqual(batches.slice(beforeRunBatch), [[actualEvent.eventId]]);
  assert.equal(
    outbox.db.prepare('SELECT synced FROM executions WHERE id=?').get(actualEvent.eventId).synced,
    1,
  );
  assert.deepEqual(
    outbox.db
      .prepare('SELECT * FROM executions WHERE id!=? ORDER BY rowid')
      .all(actualEvent.eventId),
    beforeActualRun,
    'Run recovery or auto-sync changed pre-existing capture rows.',
  );
  assert.deepEqual(
    outbox.db.prepare('SELECT * FROM sessions WHERE id!=? ORDER BY id').all(freshSession.id),
    existingAllocators,
  );
  assert.deepEqual(outbox.counts(), { pending: 2, incomplete: 2 });
  assert.deepEqual(readFileSync(configurationPath), runBindingBytes);
  assert.equal(store.dashboard(context).counts.events, healthy.length + 3);
  const afterRun = page(await inspect(captureRoot));
  assert.deepEqual(afterRun.totals, {
    all: 117,
    unsynced: 4,
    pending: 2,
    incomplete: 2,
    synced: 113,
  });

  const report = {
    completedAt: new Date().toISOString(),
    mode: 'isolated_synthetic_outbox_fixture',
    fixtureAcceptedEvents: healthy.length + 3,
    checks: [
      'compiled_cli_offline_inspection_without_api_token_or_valid_binding',
      'metadata_only_paging_filters_and_totals',
      'absent_corrupt_and_legacy_outboxes_preserved_without_migration',
      'rejected_old_session_blocks_unfiltered_atomic_batch',
      'selected_session_crosses_fifty_event_batches_with_same_ids',
      'concurrent_new_capture_remains_pending_until_its_own_retry',
      'exact_event_retry_acknowledges_once_and_preserves_other_rows',
      'selected_sync_does_not_finalize_live_or_dead_unfinished_captures',
      'binding_evidence_and_sequence_metadata_unchanged',
      'invalid_selectors_rejected_without_api_requests',
      'actual_tiny_command_auto_sync_bypasses_rejected_backlog',
    ],
    notice:
      'Disposable fixture records and one actual noninteractive Node command that prints a fixed test line were used. No user data was read and no GitHub or AI provider was called. Inspection is logically read-only; SQLite may manage WAL lock sidecars.',
  };
  safe(JSON.stringify(report));
  mkdirSync(resolve(root, '.memvora'), { recursive: true });
  writeFileSync(
    resolve(root, '.memvora/outbox-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all([...children].map(stop));
  await app.close();
  outbox?.close();
  const target = realpathSync(fixture);
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith('memvora-outbox-'))
    throw new Error('Refusing to remove an unexpected outbox fixture path.');
  rmSync(target, { recursive: true, force: true });
}
