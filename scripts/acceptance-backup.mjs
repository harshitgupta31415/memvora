import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  deriveObservedMemory,
  GitHubCredentialCipher,
  prepareEvents,
} from '../packages/core/dist/index.js';
import { SqliteEvidenceStore } from '../packages/db/dist/index.js';

// Every database, credential and captured record below is an isolated synthetic fixture.
const root = resolve(import.meta.dirname, '..');
const temporaryRoot = realpathSync(tmpdir());
const fixture = mkdtempSync(join(temporaryRoot, 'memvora-backup-'));
const dataDirectory = join(fixture, 'source');
const backupDirectory = join(fixture, 'complete-backup');
const operator = resolve(root, 'scripts/backup-local.mjs');
const files = ['.gitignore', 'manifest.json', 'server.sqlite'];
const localCredential = randomBytes(32).toString('hex');
const providerCredential = `synthetic-backup-${randomBytes(24).toString('hex')}`;
const environmentCredential = `synthetic-env-${randomBytes(24).toString('hex')}`;
const children = new Set();
const childStates = new WeakMap();
const stores = new Set();
const environment = { ...process.env, MEMVORA_DATA_DIR: dataDirectory };
for (const key of Object.keys(environment))
  if (
    key === 'MEMVORA_LOCAL_TOKEN' ||
    key === 'AI_API_KEY' ||
    key.startsWith('GITHUB_') ||
    key.startsWith('MEMVORA_AI_')
  )
    delete environment[key];

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function safe(value) {
  for (const credential of [localCredential, providerCredential, environmentCredential])
    assert.ok(!String(value).includes(credential), 'A synthetic credential was exposed.');
}
function open(path) {
  const store = new SqliteEvidenceStore(path);
  stores.add(store);
  return store;
}
function close(store) {
  store.close();
  stores.delete(store);
}
function fingerprint(database) {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  return digest(
    JSON.stringify(
      tables.map((table) => {
        assert.match(table, /^[A-Za-z_][A-Za-z0-9_]*$/u);
        const rows = database.prepare(`SELECT * FROM "${table}"`).all();
        return [table, rows.map((row) => JSON.stringify(row)).sort()];
      }),
    ),
  );
}
function denied(action, expected) {
  assert.throws(action, (error) => error?.code === expected);
}
function event(repositoryId, sessionId, sequence) {
  return {
    eventId: randomUUID(),
    repositoryId,
    sessionId,
    sequence,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'node', args: ['synthetic-backup-check.cjs'], shell: 'direct' },
    cwd: 'synthetic-project',
    git: { commitSha: null, dirty: sequence % 2 === 0 },
    outcome: { kind: 'completed', exitCode: sequence % 3 === 0 ? 1 : 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stdout', ordinal: 0, text: `SyntheticBackupMemoryNeedle ${sequence}` }],
    diffs: [
      {
        phase: 'after',
        text: `diff --git a/synthetic.txt b/synthetic.txt\n+synthetic attempt ${sequence}`,
        truncatedBytes: 0,
      },
    ],
  };
}
function ingest(store, context, events) {
  for (let offset = 0; offset < events.length; offset += 50)
    assert.deepEqual(
      store.ingest(context, prepareEvents(events.slice(offset, offset + 50))),
      events.slice(offset, offset + 50).map((item) => item.eventId),
    );
}
function imported(text, commitSha = null) {
  return {
    provider: 'github',
    fullName: 'synthetic-owner/backup-fixture',
    defaultBranch: 'main',
    commitSha,
    importedAt: '2026-10-21T10:00:00.000Z',
    partial: true,
    files: [{ path: 'src/synthetic.ts', sha: digest(text).slice(0, 40), size: text.length, text }],
    issues: [],
    pullRequests: [],
  };
}
function ownChild(child) {
  const state = { closed: false, done: undefined, stopping: undefined };
  state.done = new Promise((done) =>
    child.once('close', () => {
      state.closed = true;
      done();
    }),
  );
  childStates.set(child, state);
  children.add(child);
  return child;
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
  if (!state) throw new Error('Refusing to stop an unowned backup acceptance process.');
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (state.closed) return;
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      if (await waitForClose(state, 1000)) return;
      throw new Error('Backup process cleanup could not be confirmed. Fixture retained.');
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
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error?.code !== 'ESRCH')
          throw new Error('Backup process group cleanup failed. Fixture retained.');
      }
      await waitForClose(state, 1000);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH')
          throw new Error('Backup process group cleanup failed. Fixture retained.');
      }
    }
    if (!(await waitForClose(state, 3000)))
      throw new Error('Backup process cleanup could not be confirmed. Fixture retained.');
  })();
  return state.stopping;
}
function requestStop(child) {
  void stop(child).catch(() => {});
}
async function run(args, success = true) {
  const child = ownChild(
    spawn(process.execPath, [operator, ...args], {
      cwd: fixture,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }),
  );
  let stdout = '';
  let stderr = '';
  let overflow = false;
  let timedOut = false;
  const collect = (channel) => (chunk) => {
    if (overflow) return;
    if (channel === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout + stderr, 'utf8') > 256 * 1024) {
      overflow = true;
      requestStop(child);
    }
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));
  const timer = setTimeout(() => {
    timedOut = true;
    requestStop(child);
  }, 30_000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(timedOut, false, 'Backup operator timed out.');
    assert.equal(overflow, false, 'Backup operator exceeded its output budget.');
    assert.equal(signal, null, 'Backup operator terminated unexpectedly.');
    safe(stdout);
    safe(stderr);
    if (!success) {
      assert.notEqual(code, 0, 'Invalid backup operation unexpectedly succeeded.');
      assert.equal(stdout.trim(), '', 'A rejected operation printed a success result.');
      assert.ok(stderr.trim(), 'A rejected operation provided no failure message.');
      return null;
    }
    assert.equal(code, 0, 'Backup operator returned an unexpected failure.');
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    await stop(child);
    children.delete(child);
  }
}
function duplicateBackup(name) {
  const directory = join(fixture, name);
  mkdirSync(directory);
  for (const file of files) copyFileSync(join(backupDirectory, file), join(directory, file));
  return directory;
}
function rewriteManifest(directory, transform) {
  const path = join(directory, 'manifest.json');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  transform(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

let source;
try {
  // The supervisor's timer must remain responsive while SQLite-like synchronous
  // work blocks its separate worker. Atomics.wait is idle, not a CPU workload.
  const blockedWorker = join(fixture, 'blocked-worker.mjs');
  writeFileSync(
    blockedWorker,
    "import { writeSync } from 'node:fs';\n" +
      "writeSync(1, 'MEMVORA_BLOCKED_WORKER=' + process.pid + '\\n');\n" +
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n',
  );
  const { runBackupWorker } = await import('./lib/backup-process.mjs');
  const blockedStarted = Date.now();
  const blocked = await runBackupWorker(blockedWorker, [], { deadlineMs: 1500 });
  assert.equal(
    blocked.timedOut,
    true,
    'An independently supervised synchronous worker did not time out.',
  );
  assert.notEqual(blocked.code, 0);
  assert.ok(
    Date.now() - blockedStarted < 5000,
    'Synchronous worker cleanup exceeded five seconds.',
  );
  const blockedPid = Number(blocked.stdout.match(/^MEMVORA_BLOCKED_WORKER=(\d+)$/mu)?.[1]);
  assert.ok(
    Number.isSafeInteger(blockedPid) && blockedPid > 0,
    'The synchronous worker never reached its blocking operation.',
  );
  assert.throws(
    () => process.kill(blockedPid, 0),
    (error) => error?.code === 'ESRCH',
    'The timed-out worker remained alive.',
  );
  mkdirSync(dataDirectory);
  const credentialFile = join(dataDirectory, 'local-token');
  const environmentFile = join(dataDirectory, '.env');
  const externalRepository = join(fixture, 'external-repository', '.memvora');
  mkdirSync(externalRepository, { recursive: true });
  const outboxFile = join(externalRepository, 'outbox.sqlite');
  const bindingFile = join(externalRepository, 'config.json');
  writeFileSync(credentialFile, `${localCredential}\n`, { mode: 0o600 });
  writeFileSync(environmentFile, `AI_API_KEY=${environmentCredential}\n`, { mode: 0o600 });
  writeFileSync(outboxFile, 'Synthetic unuploaded outbox bytes: excluded from server backup.');
  writeFileSync(bindingFile, '{"syntheticFixture":true}\n');
  const unchangedFiles = [credentialFile, environmentFile, outboxFile, bindingFile].map((path) => [
    path,
    readFileSync(path),
  ]);

  source = open(join(dataDirectory, 'server.sqlite'));
  source.database.exec('PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);');
  const context = source.context();
  const repository = source.createRepository(context, { name: 'Synthetic backup investigation' });
  const session = source.createSession(context, {
    repositoryId: repository.id,
    title: 'SyntheticBackupDirectoryNeedle',
  });
  const events = Array.from({ length: 110 }, (_unused, index) =>
    event(repository.id, session.id, index + 2),
  );
  ingest(source, context, events);
  for (let index = 0; index < 108; index++) {
    const job = source.claimJob();
    assert.ok(job);
    assert.equal(source.completeJob(job, deriveObservedMemory(job.event)), true);
  }
  assert.ok(source.claimJob(), 'A running job fixture was not created.');
  const initialPage = source.getSessionEvents(context, session.id, { limit: 5 });
  assert.ok(initialPage.page.olderCursor);
  assert.equal(initialPage.page.snapshotEventCount, events.length);

  const notes = ['note', 'decision', 'resolution'].map(
    (kind, index) =>
      source.createSessionNote(context, session.id, {
        id: randomUUID(),
        kind,
        body: `SyntheticBackupJournalNeedle: explicitly synthetic ${kind}.`,
        eventIds: [events[index * 50].eventId],
      }).note,
  );
  source.saveRepositoryContext(
    context,
    repository.id,
    imported('export const SyntheticBackupOldSourceNeedle = 1;'),
  );
  const oldSourceId = source.getRepositoryContext(context, repository.id).files[0].sourceId;
  source.saveRepositoryContext(
    context,
    repository.id,
    imported('export const SyntheticBackupCurrentSourceNeedle = 2;', 'b'.repeat(40)),
  );
  const currentSourceId = source.getRepositoryContext(context, repository.id).files[0].sourceId;
  assert.notEqual(oldSourceId, currentSourceId);
  const closed = source.createSession(context, {
    repositoryId: repository.id,
    title: 'Closed fixture',
  });
  source.closeSession(context, closed.id);

  const deletedRepository = source.createRepository(context, { name: 'Deleted synthetic scope' });
  const deletedRepositorySession = source.createSession(context, {
    repositoryId: deletedRepository.id,
  });
  ingest(source, context, [event(deletedRepository.id, deletedRepositorySession.id, 1)]);
  source.saveRepositoryContext(
    context,
    deletedRepository.id,
    imported('export const DeletedBackupSourceMustRemainUnavailable = true;'),
  );
  const deletedSourceId = source.getRepositoryContext(context, deletedRepository.id).files[0]
    .sourceId;
  source.deleteRepository(context, deletedRepository.id);
  const deletedSession = source.createSession(context, { repositoryId: repository.id });
  const deletedLastEvent = event(repository.id, deletedSession.id, 1);
  ingest(source, context, [deletedLastEvent]);
  const deletedIntake = Number(
    source.database
      .prepare('SELECT id FROM local_event_intakes WHERE event_id=?')
      .get(deletedLastEvent.eventId).id,
  );
  source.deleteSession(context, deletedSession.id);

  const cipher = new GitHubCredentialCipher(localCredential);
  const configHash = digest('synthetic app configuration');
  const encryptedTokens = cipher.encrypt(context, `tokens:${configHash}`, providerCredential);
  source.saveGitHubConnection(
    context,
    {
      configHash,
      user: { id: 12345, login: 'synthetic-fixture', avatarUrl: 'https://example.invalid/avatar' },
      encryptedTokens,
      expiresAt: null,
    },
    source.githubConnectionRevision(context),
  );
  const pendingOAuth = source.beginGitHubOAuth(context, {
    stateHash: digest('synthetic state'),
    browserHash: digest('synthetic browser'),
    configHash,
    encryptedVerifier: cipher.encrypt(context, `oauth:${configHash}`, 'synthetic verifier'),
    expiresAt: Date.now() + 10 * 60_000,
  });
  const expectedConnection = source.getGitHubConnection(context);
  const sourceFingerprint = fingerprint(source.database);
  const sourceChanges = source.database.prepare('SELECT total_changes() AS count').get().count;
  assert.ok(statSync(join(dataDirectory, 'server.sqlite-wal')).size > 32);
  const bareFile = join(fixture, 'main-file-without-wal.sqlite');
  copyFileSync(source.path, bareFile);
  const bare = new DatabaseSync(bareFile, { readOnly: true });
  try {
    assert.equal(bare.prepare('SELECT count(*) AS count FROM local_events').get().count, 0);
  } finally {
    bare.close();
  }

  const created = await run(['create', '--data-dir', dataDirectory, '--output', backupDirectory]);
  assert.equal(created.status, 'created_and_verified');
  assert.equal(resolve(created.directory), backupDirectory);
  const manifest = JSON.parse(readFileSync(join(backupDirectory, 'manifest.json'), 'utf8'));
  assert.deepEqual(created.manifest, manifest);
  assert.deepEqual(readdirSync(backupDirectory).sort(), files);
  assert.equal(readFileSync(join(backupDirectory, '.gitignore'), 'utf8'), '*\n');
  assert.equal(manifest.format, 'memvora-local-backup');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.database.file, 'server.sqlite');
  assert.equal(manifest.database.schemaVersion, 9);
  const snapshotPath = join(backupDirectory, 'server.sqlite');
  const snapshotBytes = readFileSync(snapshotPath);
  safe(snapshotBytes);
  assert.equal(manifest.database.byteLength, snapshotBytes.length);
  assert.equal(manifest.database.sha256, digest(snapshotBytes));
  assert.deepEqual(manifest.contents, {
    encryptedGitHubState: 'retained',
    localApiCredential: 'excluded',
    environment: 'excluded',
    cliOutboxes: 'excluded',
  });
  assert.equal(manifest.counts.events, events.length);
  assert.equal(manifest.counts.memories, 108);
  assert.equal(manifest.counts.notes, notes.length);
  assert.equal(manifest.counts.repositorySources, 2);
  assert.equal(manifest.counts.eventIntakes, events.length);
  assert.equal(manifest.counts.jobs, events.length);
  assert.equal(manifest.counts.deletedRepositories, 1);
  assert.equal(manifest.counts.deletedSessions, 2);
  assert.equal(manifest.counts.deletedWorkspaces, 0);
  safe(JSON.stringify(manifest));
  const verified = await run(['verify', '--input', backupDirectory]);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.directory, backupDirectory);
  assert.equal(verified.liveRestorePerformed, false);
  assert.deepEqual(verified.manifest, manifest);
  assert.deepEqual(readFileSync(snapshotPath), snapshotBytes, 'Verification modified the backup.');
  const defaultCreated = await run(['create', '--data-dir', dataDirectory]);
  assert.equal(defaultCreated.status, 'created_and_verified');
  assert.equal(dirname(defaultCreated.directory), join(dataDirectory, 'backups'));
  assert.deepEqual(defaultCreated.manifest.counts, manifest.counts);
  assert.equal(readFileSync(join(dataDirectory, 'backups', '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(readdirSync(defaultCreated.directory).sort(), files);
  assert.equal(
    (await run(['verify', '--input', defaultCreated.directory])).liveRestorePerformed,
    false,
  );

  // A linked ancestor must be refused before the operator creates its default
  // backups parent. Use a separate source with no earlier default destination.
  const linkTarget = join(fixture, 'linked-ancestor-target');
  const linkedSource = join(linkTarget, 'source');
  mkdirSync(linkedSource, { recursive: true });
  copyFileSync(snapshotPath, join(linkedSource, 'server.sqlite'));
  const link = join(fixture, 'linked-ancestor-alias');
  symlinkSync(linkTarget, link, 'junction');
  assert.deepEqual(readdirSync(linkedSource), ['server.sqlite']);
  const linkedSourceBytes = readFileSync(join(linkedSource, 'server.sqlite'));
  await run(['create', '--data-dir', join(link, 'source')], false);
  assert.deepEqual(readdirSync(linkTarget), ['source']);
  assert.deepEqual(readdirSync(linkedSource), ['server.sqlite']);
  assert.equal(existsSync(join(linkedSource, 'backups')), false);
  assert.deepEqual(readFileSync(join(linkedSource, 'server.sqlite')), linkedSourceBytes);

  const rehearsalDirectory = join(fixture, 'restore-rehearsal');
  mkdirSync(rehearsalDirectory);
  const rehearsalPath = join(rehearsalDirectory, 'server.sqlite');
  copyFileSync(snapshotPath, rehearsalPath);
  let rehearsal = open(rehearsalPath);
  assert.deepEqual(rehearsal.context(), context);
  assert.equal(fingerprint(rehearsal.database), sourceFingerprint);
  close(rehearsal);
  rehearsal = open(rehearsalPath);
  assert.deepEqual(rehearsal.getSessionEvents(context, session.id, { limit: 5 }), initialPage);
  assert.equal(rehearsal.getSession(context, closed.id).session.status, 'closed');
  for (const captured of events)
    assert.deepEqual(
      rehearsal.getEvent(context, captured.eventId),
      source.getEvent(context, captured.eventId),
    );
  for (const note of notes) {
    assert.deepEqual(rehearsal.getSessionNote(context, note.id), note);
    for (const citation of note.sources)
      assert.equal(rehearsal.getEvent(context, citation.id).sessionId, note.sessionId);
  }
  assert.deepEqual(
    rehearsal.search(context, { query: 'SyntheticBackupMemoryNeedle', limit: 20 }),
    source.search(context, { query: 'SyntheticBackupMemoryNeedle', limit: 20 }),
  );
  assert.equal(
    rehearsal.search(context, { query: 'SyntheticBackupMemoryNeedle', limit: 20 }).length,
    20,
  );
  assert.deepEqual(
    rehearsal.searchSessionNotes(context, { query: 'SyntheticBackupJournalNeedle', limit: 20 }),
    source.searchSessionNotes(context, { query: 'SyntheticBackupJournalNeedle', limit: 20 }),
  );
  assert.deepEqual(
    rehearsal
      .searchSessionNotes(context, { query: 'SyntheticBackupJournalNeedle', limit: 20 })
      .map((note) => note.id)
      .sort(),
    notes.map((note) => note.id).sort(),
  );
  assert.deepEqual(
    rehearsal.searchRepositorySources(context, { query: 'SyntheticBackupCurrentSourceNeedle' }),
    source.searchRepositorySources(context, { query: 'SyntheticBackupCurrentSourceNeedle' }),
  );
  assert.equal(
    rehearsal.searchRepositorySources(context, { query: 'SyntheticBackupCurrentSourceNeedle' })[0]
      .source.id,
    currentSourceId,
  );
  assert.deepEqual(
    rehearsal.searchRepositorySources(context, { query: 'SyntheticBackupOldSourceNeedle' }),
    [],
  );
  for (const id of [oldSourceId, currentSourceId])
    assert.deepEqual(
      rehearsal.getRepositorySource(context, id),
      source.getRepositorySource(context, id),
    );
  denied(() => rehearsal.getRepository(context, deletedRepository.id), 'NOT_FOUND');
  denied(() => rehearsal.getSession(context, deletedSession.id), 'NOT_FOUND');
  denied(() => rehearsal.getSession(context, deletedRepositorySession.id), 'NOT_FOUND');
  denied(() => rehearsal.getRepositorySource(context, deletedSourceId), 'NOT_FOUND');
  assert.deepEqual(rehearsal.getGitHubConnection(context), expectedConnection);
  assert.equal(
    cipher.decrypt(context, `tokens:${configHash}`, expectedConnection.encryptedTokens),
    providerCredential,
  );
  denied(
    () =>
      new GitHubCredentialCipher(randomBytes(32).toString('hex')).decrypt(
        context,
        `tokens:${configHash}`,
        expectedConnection.encryptedTokens,
      ),
    'GITHUB_RECONNECT_REQUIRED',
  );
  assert.equal(
    rehearsal.database
      .prepare('SELECT expected_revision FROM local_github_oauth_attempts WHERE workspace_id=?')
      .get(context.workspace.id).expected_revision,
    pendingOAuth.expectedRevision,
  );
  assert.equal(
    fingerprint(rehearsal.database),
    sourceFingerprint,
    'Rehearsal reads ran jobs or changed evidence.',
  );

  const late = [event(repository.id, session.id, 1), event(repository.id, session.id, 112)];
  ingest(rehearsal, context, late);
  for (const captured of late)
    assert.ok(
      Number(
        rehearsal.database
          .prepare('SELECT id FROM local_event_intakes WHERE event_id=?')
          .get(captured.eventId).id,
      ) > deletedIntake,
    );
  let page = initialPage;
  const recovered = [...page.events];
  while (page.page.olderCursor) {
    page = rehearsal.getSessionEvents(context, session.id, {
      limit: 17,
      cursor: page.page.olderCursor,
    });
    assert.equal(page.page.snapshotEventCount, events.length);
    recovered.unshift(...page.events);
    assert.ok(recovered.length <= events.length, 'Cursor traversal repeated snapshot members.');
  }
  assert.deepEqual(
    recovered.map((captured) => captured.eventId),
    events.map((captured) => captured.eventId),
  );
  assert.equal(new Set(recovered.map((captured) => captured.eventId)).size, events.length);
  assert.equal(
    rehearsal.getSessionEvents(context, session.id).page.snapshotEventCount,
    events.length + late.length,
  );
  close(rehearsal);

  const existing = join(fixture, 'existing-output');
  mkdirSync(existing);
  writeFileSync(join(existing, 'sentinel.txt'), 'must remain untouched');
  await run(['create', '--data-dir', dataDirectory, '--output', existing], false);
  assert.deepEqual(readdirSync(existing), ['sentinel.txt']);
  assert.equal(readFileSync(join(existing, 'sentinel.txt'), 'utf8'), 'must remain untouched');
  await run(
    ['create', '--data-dir', 'relative-source', '--output', join(fixture, 'invalid-output')],
    false,
  );
  const missingSource = join(fixture, 'missing-source');
  mkdirSync(missingSource);
  await run(
    ['create', '--data-dir', missingSource, '--output', join(fixture, 'missing-output')],
    false,
  );
  assert.deepEqual(readdirSync(missingSource), []);
  await run(['verify', '--input', backupDirectory, '--data-dir', dataDirectory], false);
  await run(['verify', '--input', backupDirectory, '--input', backupDirectory], false);
  await run(
    ['create', '--data-dir', dataDirectory, '--unexpected', join(fixture, 'unknown-output')],
    false,
  );
  await run(
    [
      'create',
      '--data-dir',
      dataDirectory,
      '--output',
      backupDirectory,
      '--output',
      backupDirectory,
    ],
    false,
  );
  await run(['create', '--data-dir'], false);

  const tampered = duplicateBackup('tampered-database');
  const damaged = readFileSync(join(tampered, 'server.sqlite'));
  damaged[Math.floor(damaged.length / 2)] ^= 1;
  writeFileSync(join(tampered, 'server.sqlite'), damaged);
  await run(['verify', '--input', tampered], false);
  const wrongCounts = duplicateBackup('tampered-counts');
  rewriteManifest(wrongCounts, (value) => value.counts.events++);
  await run(['verify', '--input', wrongCounts], false);
  const malformed = duplicateBackup('malformed-manifest');
  writeFileSync(join(malformed, 'manifest.json'), '{');
  await run(['verify', '--input', malformed], false);
  const additionalFile = duplicateBackup('unexpected-entry');
  writeFileSync(join(additionalFile, 'unexpected.txt'), 'not part of the backup contract');
  await run(['verify', '--input', additionalFile], false);
  const newer = duplicateBackup('newer-schema');
  const future = new DatabaseSync(join(newer, 'server.sqlite'));
  try {
    future.exec('PRAGMA user_version=10');
  } finally {
    future.close();
  }
  const newerBytes = readFileSync(join(newer, 'server.sqlite'));
  rewriteManifest(newer, (value) => {
    value.database.byteLength = newerBytes.length;
    value.database.sha256 = digest(newerBytes);
  });
  await run(['verify', '--input', newer], false);
  await run(['create', '--data-dir', newer, '--output', join(fixture, 'newer-output')], false);

  assert.equal(
    fingerprint(source.database),
    sourceFingerprint,
    'Backup/rehearsal changed the source store.',
  );
  assert.equal(
    source.database.prepare('SELECT total_changes() AS count').get().count,
    sourceChanges,
  );
  for (const [path, bytes] of unchangedFiles) assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(readFileSync(snapshotPath), snapshotBytes, 'The original backup was changed.');
  const report = {
    completedAt: new Date().toISOString(),
    mode: 'isolated_synthetic_backup_fixture',
    fixtureEvents: events.length,
    checks: [
      'compiled_operator_create_and_verify',
      'independent_deadline_interrupts_idle_synchronous_worker_and_reaps_it',
      'committed_wal_evidence_preserved_while_source_open',
      'complete_ids_provenance_fts_notes_and_historical_sources',
      'separate_restore_rehearsal_without_workers_or_providers',
      'cursor_signing_restart_fixed_snapshot_and_monotonic_intakes',
      'deletion_tombstones_and_closed_state_preserved',
      'encrypted_oauth_state_retained_without_external_credential_files',
      'invalid_tampered_existing_and_newer_schema_rejected',
      'linked_ancestor_rejected_before_default_destination_writes',
      'source_bindings_outbox_and_credentials_unchanged',
      'no_credentials_in_operator_output_or_manifest',
    ],
    notice:
      'Only disposable synthetic evidence was used. No live restore, API listener, worker, GitHub/AI call, user data read or external upload occurred. Snapshot copies remain independent of later live deletions.',
  };
  safe(JSON.stringify(report));
  mkdirSync(resolve(root, '.memvora'), { recursive: true });
  writeFileSync(
    resolve(root, '.memvora/backup-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  const cleanup = await Promise.allSettled([...children].map(stop));
  for (const store of stores) store.close();
  if (cleanup.some((result) => result.status === 'rejected'))
    throw new Error('Backup process cleanup could not be confirmed. Fixture retained.');
  if (existsSync(fixture)) {
    const target = realpathSync(fixture);
    if (dirname(target) !== temporaryRoot || !basename(target).startsWith('memvora-backup-'))
      throw new Error('Refusing to remove an unexpected backup fixture path.');
    rmSync(target, { recursive: true, force: true });
  }
}
