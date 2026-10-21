import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { prepareEvents } from '@memvora/core';
import { createLocalBackup, LocalBackupError, verifyLocalBackup } from './local-backup.js';
import { SqliteEvidenceStore } from './sqlite-store.js';

const temporaryRoot = realpathSync(tmpdir());
const folders: string[] = [];
const stores: SqliteEvidenceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of folders.splice(0)) {
    const target = realpathSync(resolve(directory));
    if (
      dirname(target) !== temporaryRoot ||
      !target.startsWith(join(temporaryRoot, 'memvora-backup-')) ||
      !basename(target).startsWith('memvora-backup-')
    )
      throw new Error('Unsafe backup fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(temporaryRoot, 'memvora-backup-'));
  folders.push(root);
  const dataDirectory = join(root, 'source');
  const outputDirectory = join(root, 'snapshot');
  mkdirSync(dataDirectory);
  const store = new SqliteEvidenceStore(join(dataDirectory, 'server.sqlite'));
  stores.push(store);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Synthetic backup repository' });
  const session = store.createSession(context, {
    repositoryId: repository.id,
    title: 'Synthetic backup investigation',
  });
  const events: CapturedEvent[] = Array.from({ length: 5 }, (_item, index) => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: index + 2,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'synthetic-observation', args: [], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      { stream: 'stdout', ordinal: 0, text: 'Synthetic fixture evidence, no command executed.' },
    ],
    diffs: [],
  }));
  store.ingest(context, prepareEvents(events));
  const note = store.createSessionNote(context, session.id, {
    id: randomUUID(),
    kind: 'note',
    body: 'Synthetic author statement for backup testing.',
    eventIds: [events[0]!.eventId],
  }).note;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const encryptedTokens = 'opaque-synthetic-encrypted-token-envelope';
  store.saveGitHubConnection(
    context,
    {
      user: {
        id: 12345,
        login: 'synthetic-backup-owner',
        avatarUrl: 'https://example.invalid/avatar',
      },
      configHash: hash('synthetic-config'),
      encryptedTokens,
      expiresAt: null,
    },
    0,
  );
  const attempt = store.beginGitHubOAuth(context, {
    stateHash: hash('synthetic-state'),
    browserHash: hash('synthetic-browser'),
    configHash: hash('synthetic-config'),
    encryptedVerifier: 'opaque-synthetic-encrypted-verifier',
    expiresAt: Date.now() + 60_000,
  });
  const disposable = store.createRepository(context, { name: 'Synthetic deleted scope' });
  const removedSession = store.createSession(context, { repositoryId: disposable.id });
  store.ingest(
    context,
    prepareEvents([
      {
        ...events[0]!,
        eventId: randomUUID(),
        repositoryId: disposable.id,
        sessionId: removedSession.id,
        sequence: 1,
      },
    ]),
  );
  store.deleteRepository(context, disposable.id);
  return {
    root,
    dataDirectory,
    outputDirectory,
    store,
    context,
    repository,
    session,
    events,
    note,
    attempt,
    encryptedTokens,
  };
}
function readDatabase(path: string, read: (database: DatabaseSync) => unknown) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}
function rewriteManifest(directory: string, change: (value: Record<string, unknown>) => void) {
  const path = join(directory, 'manifest.json');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(value);
  writeFileSync(path, JSON.stringify(value));
}

describe('local same-instance SQLite snapshots', () => {
  it('captures committed WAL evidence and private state without changing the live database or copying external credentials', async () => {
    const f = fixture();
    const source = join(f.dataDirectory, 'server.sqlite');
    const credential = 'private-external-fixture-credential-must-never-be-copied';
    for (const file of ['local-token', '.env', 'outbox.sqlite'])
      writeFileSync(join(f.dataDirectory, file), credential);
    expect(existsSync(`${source}-wal`)).toBe(true);
    const before = readFileSync(source);
    const walBefore = readFileSync(`${source}-wal`);
    const cursor = f.store.getSessionEvents(f.context, f.session.id, { limit: 2 }).page.olderCursor;
    expect(cursor).not.toBeNull();
    const key = readDatabase(
      source,
      (database) =>
        database.prepare('SELECT cursor_secret FROM local_history_state').get()?.['cursor_secret'],
    );
    const result = await createLocalBackup({
      dataDirectory: f.dataDirectory,
      outputDirectory: f.outputDirectory,
    });
    expect(result.directory).toBe(f.outputDirectory);
    expect(result.manifest.counts).toMatchObject({
      events: 5,
      eventIntakes: 5,
      notes: 1,
      jobs: 5,
      deletedRepositories: 1,
      deletedSessions: 1,
    });
    expect(readdirSync(f.outputDirectory).sort()).toEqual([
      '.gitignore',
      'manifest.json',
      'server.sqlite',
    ]);
    expect(readFileSync(source)).toEqual(before);
    expect(readFileSync(`${source}-wal`)).toEqual(walBefore);
    const snapshot = join(f.outputDirectory, 'server.sqlite');
    readDatabase(snapshot, (database) => {
      expect(database.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('delete');
      expect(
        database.prepare('SELECT cursor_secret FROM local_history_state').get()?.['cursor_secret'],
      ).toBe(key);
      expect(
        database.prepare('SELECT encrypted_tokens FROM local_github_connections').get()?.[
          'encrypted_tokens'
        ],
      ).toBe(f.encryptedTokens);
      expect(
        database
          .prepare('SELECT encrypted_verifier,expected_revision FROM local_github_oauth_attempts')
          .get(),
      ).toMatchObject({
        encrypted_verifier: f.attempt.encryptedVerifier,
        expected_revision: f.attempt.expectedRevision,
      });
      expect(
        database
          .prepare("SELECT seq FROM sqlite_sequence WHERE name='local_event_intakes'")
          .get()?.['seq'],
      ).toBe(6);
      expect(
        database.prepare('SELECT id,event_ids_json FROM local_session_notes').get(),
      ).toMatchObject({ id: f.note.id, event_ids_json: JSON.stringify([f.events[0]!.eventId]) });
      expect(
        database.prepare('SELECT count(*) AS count FROM local_session_note_fts').get()?.['count'],
      ).toBe(1);
    });
    const backupBytes = readFileSync(snapshot);
    const manifestBytes = readFileSync(join(f.outputDirectory, 'manifest.json'));
    expect(await verifyLocalBackup(f.outputDirectory)).toEqual(result.manifest);
    expect(readFileSync(snapshot)).toEqual(backupBytes);
    expect(readFileSync(join(f.outputDirectory, 'manifest.json'))).toEqual(manifestBytes);
    expect(readdirSync(f.outputDirectory).sort()).toEqual([
      '.gitignore',
      'manifest.json',
      'server.sqlite',
    ]);
    const report = JSON.stringify(result.manifest);
    for (const privateValue of [
      credential,
      f.encryptedTokens,
      f.attempt.encryptedVerifier,
      f.context.user.id,
      key,
    ])
      expect(report).not.toContain(privateValue);
    // Recovery is rehearsed only on another disposable copy, never on the source or completed backup.
    const rehearsal = join(f.root, 'rehearsal.sqlite');
    copyFileSync(snapshot, rehearsal);
    const reopened = new SqliteEvidenceStore(rehearsal);
    stores.push(reopened);
    const page = reopened.getSessionEvents(f.context, f.session.id, { limit: 2, cursor: cursor! });
    expect(page.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(reopened.getSessionNote(f.context, f.note.id)).toEqual(f.note);
    expect(() =>
      reopened.getRepository(
        f.context,
        readDatabase(
          snapshot,
          (database) =>
            database.prepare("SELECT id FROM local_repositories WHERE status='deleted'").get()?.[
              'id'
            ],
        ) as string,
      ),
    ).toThrow();
    expect(readFileSync(snapshot)).toEqual(backupBytes);
  });

  it('claims a new destination exclusively and preserves an existing folder or linked target', async () => {
    const f = fixture();
    mkdirSync(f.outputDirectory);
    const marker = join(f.outputDirectory, 'keep.txt');
    writeFileSync(marker, 'existing destination');
    await expect(createLocalBackup(f)).rejects.toMatchObject({ code: 'INVALID_BACKUP_PATH' });
    await expect(
      createLocalBackup({ dataDirectory: f.dataDirectory, outputDirectory: f.outputDirectory }),
    ).rejects.toMatchObject({ code: 'BACKUP_TARGET_EXISTS' });
    expect(readFileSync(marker, 'utf8')).toBe('existing destination');
    const link = join(f.root, 'linked-target');
    symlinkSync(f.outputDirectory, link, 'junction');
    await expect(
      createLocalBackup({ dataDirectory: f.dataDirectory, outputDirectory: link }),
    ).rejects.toBeInstanceOf(LocalBackupError);
    expect(readdirSync(f.outputDirectory)).toEqual(['keep.txt']);
    const linkedParent = join(f.root, 'linked-parent');
    symlinkSync(f.dataDirectory, linkedParent, 'junction');
    await expect(
      createLocalBackup({
        dataDirectory: f.dataDirectory,
        outputDirectory: join(linkedParent, 'new'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BACKUP_PATH' });
  });

  it('does not create a missing source or migrate unrelated/newer databases and never exposes database diagnostics', async () => {
    const f = fixture();
    const absent = join(f.root, 'absent-source');
    mkdirSync(absent);
    const output = join(f.root, 'absent-output');
    await expect(
      createLocalBackup({ dataDirectory: absent, outputDirectory: output }),
    ).rejects.toBeInstanceOf(LocalBackupError);
    expect(existsSync(join(absent, 'server.sqlite'))).toBe(false);
    expect(existsSync(output)).toBe(false);
    const malformed = join(absent, 'server.sqlite');
    writeFileSync(malformed, 'PRIVATE_SQLITE_DIAGNOSTIC_FIXTURE');
    const failure = await createLocalBackup({
      dataDirectory: absent,
      outputDirectory: output,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LocalBackupError);
    expect(String(failure)).not.toContain('PRIVATE_SQLITE_DIAGNOSTIC_FIXTURE');
    expect(existsSync(output)).toBe(false);
    const future = join(f.root, 'future');
    mkdirSync(future);
    const database = new DatabaseSync(join(future, 'server.sqlite'));
    database.exec('PRAGMA user_version=8');
    database.close();
    const before = readFileSync(join(future, 'server.sqlite'));
    await expect(
      createLocalBackup({ dataDirectory: future, outputDirectory: output }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_BACKUP_SCHEMA' });
    expect(readFileSync(join(future, 'server.sqlite'))).toEqual(before);
    expect(existsSync(output)).toBe(false);
  });

  it('rejects linked source files, relative/network paths and a missing destination parent before creating output', async () => {
    const f = fixture();
    const linked = join(f.root, 'linked-source');
    mkdirSync(linked);
    linkSync(join(f.dataDirectory, 'server.sqlite'), join(linked, 'server.sqlite'));
    await expect(
      createLocalBackup({ dataDirectory: linked, outputDirectory: f.outputDirectory }),
    ).rejects.toBeInstanceOf(LocalBackupError);
    for (const outputDirectory of [
      'relative-output',
      '\\\\server\\share\\snapshot',
      join(f.root, 'missing', 'snapshot'),
    ]) {
      await expect(
        createLocalBackup({ dataDirectory: f.dataDirectory, outputDirectory }),
      ).rejects.toBeInstanceOf(LocalBackupError);
    }
    expect(existsSync(f.outputDirectory)).toBe(false);
  });

  it('retains an incomplete claimed directory without a completion manifest when logical validation fails', async () => {
    const f = fixture();
    const database = new DatabaseSync(join(f.dataDirectory, 'server.sqlite'));
    database.exec('DELETE FROM local_history_state');
    database.close();
    await expect(
      createLocalBackup({ dataDirectory: f.dataDirectory, outputDirectory: f.outputDirectory }),
    ).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    expect(existsSync(join(f.outputDirectory, 'server.sqlite'))).toBe(true);
    expect(existsSync(join(f.outputDirectory, 'manifest.json'))).toBe(false);
    await expect(verifyLocalBackup(f.outputDirectory)).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
    });
  });

  it('rejects altered metadata, unknown manifest paths and modified database bytes', async () => {
    const f = fixture();
    await createLocalBackup({ dataDirectory: f.dataDirectory, outputDirectory: f.outputDirectory });
    const original = readFileSync(join(f.outputDirectory, 'manifest.json'));
    const mutations = [
      (value: Record<string, unknown>) => {
        value['extra'] = 'unexpected';
      },
      (value: Record<string, unknown>) => {
        (value['database'] as Record<string, unknown>)['file'] = '../server.sqlite';
      },
      (value: Record<string, unknown>) => {
        (value['counts'] as Record<string, unknown>)['events'] = 999;
      },
      (value: Record<string, unknown>) => {
        (value['contents'] as Record<string, unknown>)['localApiCredential'] = 'retained';
      },
      (value: Record<string, unknown>) => {
        value['createdAt'] = '2026-02-30T00:00:00.000Z';
      },
    ];
    for (const mutate of mutations) {
      writeFileSync(join(f.outputDirectory, 'manifest.json'), original);
      rewriteManifest(f.outputDirectory, mutate);
      await expect(verifyLocalBackup(f.outputDirectory)).rejects.toMatchObject({
        code: 'BACKUP_INVALID',
      });
    }
    writeFileSync(join(f.outputDirectory, 'manifest.json'), original);
    appendFileSync(join(f.outputDirectory, 'server.sqlite'), 'altered');
    await expect(verifyLocalBackup(f.outputDirectory)).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
    });
  });

  it('rejects extra credentials, sidecars and linked manifest files without writing to the snapshot', async () => {
    const f = fixture();
    await createLocalBackup({ dataDirectory: f.dataDirectory, outputDirectory: f.outputDirectory });
    const snapshot = readFileSync(join(f.outputDirectory, 'server.sqlite'));
    for (const extra of ['local-token', '.env', 'server.sqlite-wal', 'server.sqlite-shm']) {
      writeFileSync(join(f.outputDirectory, extra), 'private-extra-fixture');
      await expect(verifyLocalBackup(f.outputDirectory)).rejects.toMatchObject({
        code: 'BACKUP_INVALID',
      });
      rmSync(join(f.outputDirectory, extra));
    }
    const external = join(f.root, 'external-manifest.json');
    copyFileSync(join(f.outputDirectory, 'manifest.json'), external);
    rmSync(join(f.outputDirectory, 'manifest.json'));
    linkSync(external, join(f.outputDirectory, 'manifest.json'));
    await expect(verifyLocalBackup(f.outputDirectory)).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
    });
    expect(readFileSync(join(f.outputDirectory, 'server.sqlite'))).toEqual(snapshot);
  });
});
