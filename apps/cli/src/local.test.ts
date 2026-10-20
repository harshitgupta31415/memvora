import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { recoverIncomplete } from './capture.js';
import { ensurePrivateDirectory, LocalOutbox, writeBinding } from './local.js';

function removeFixtureDirectory(directory: string): void {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('memvora-'))
    throw new Error('Unexpected test cleanup target.');
  rmSync(target, { recursive: true, force: true });
}

describe('local outbox acknowledgement', () => {
  it('preserves repeated executions and leaves an event arriving during upload pending', () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      expect(outbox.begin('first', 'session', {})).toBe(1);
      outbox.finalize('first', { command: 'same' });
      const uploaded = outbox.pending();
      expect(outbox.begin('second', 'session', {})).toBe(2);
      outbox.finalize('second', { command: 'same' });
      outbox.acknowledge(
        ['first'],
        uploaded.map((event) => event.eventId),
      );
      expect(outbox.pending().map((event) => event.eventId)).toEqual(['second']);
      expect(() => outbox.acknowledge(['second'], ['first'])).toThrow('outside');
    } finally {
      outbox.close();
    }
  });

  it('leaves a live owner running while recovering only a confirmed dead process', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-owner-'));
    const path = join(directory, 'outbox.sqlite');
    const outbox = new LocalOutbox(path);
    const initial = {
      eventId: 'dead',
      repositoryId: 'repo',
      sessionId: 'session',
      startedAt: new Date().toISOString(),
      command: { executable: 'node', args: [], shell: 'direct' },
      cwd: directory,
      git: { commitSha: null, dirty: false },
      diffs: [],
    };
    const deadPid = 2_147_483_647;
    const inaccessiblePid = deadPid - 1;
    outbox.begin('live', 'session', { ...initial, eventId: 'live' });
    outbox.begin('dead', 'session', initial);
    outbox.begin('protected', 'session', { ...initial, eventId: 'protected' });
    const fixtureDb = new DatabaseSync(path);
    fixtureDb.prepare('UPDATE executions SET owner_pid=? WHERE id=?').run(deadPid, 'dead');
    fixtureDb
      .prepare('UPDATE executions SET owner_pid=? WHERE id=?')
      .run(inaccessiblePid, 'protected');
    fixtureDb.close();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid)
        throw Object.assign(new Error('Fixture owner no longer exists.'), { code: 'ESRCH' });
      if (pid === inaccessiblePid)
        throw Object.assign(new Error('Fixture owner cannot be inspected.'), { code: 'EPERM' });
      return true;
    });
    try {
      expect(recoverIncomplete(outbox)).toBe(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 0);
      expect(
        outbox
          .incomplete()
          .map((row) => row.eventId)
          .sort(),
      ).toEqual(['live', 'protected']);
      expect(outbox.pending()[0]?.payload['outcome']).toMatchObject({
        kind: 'incomplete',
        exitCode: null,
      });
      outbox.append('live', 0, 'stdout', 'still running\n');
      outbox.finalize('live', {
        outcome: { kind: 'completed', exitCode: 0 },
        output: outbox.output('live'),
      });
      expect(outbox.pending().find((row) => row.eventId === 'live')?.payload['outcome']).toEqual({
        kind: 'completed',
        exitCode: 0,
      });
    } finally {
      kill.mockRestore();
      outbox.close();
      removeFixtureDirectory(directory);
    }
  });

  it('migrates old outboxes without guessing whether unknown owners are dead', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-owner-migration-'));
    const path = join(directory, 'outbox.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE executions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, initial_payload TEXT NOT NULL, payload TEXT, synced INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT 'fixture')",
    );
    legacy
      .prepare('INSERT INTO executions(id,session_id,sequence,initial_payload) VALUES(?,?,?,?)')
      .run('legacy', 'session', 1, '{}');
    legacy.close();
    const outbox = new LocalOutbox(path);
    try {
      expect(outbox.incomplete()[0]?.ownerPid).toBeNull();
      expect(recoverIncomplete(outbox)).toBe(0);
      expect(outbox.counts().incomplete).toBe(1);
    } finally {
      outbox.close();
      removeFixtureDirectory(directory);
    }
  });

  it('writes private capture ignore rules before config and preserves an existing ignore file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-ignore-'));
    const privateDirectory = join(directory, '.memvora');
    try {
      writeBinding(directory, {
        schemaVersion: 1,
        repositoryId: 'fixture',
        apiUrl: 'http://127.0.0.1:4000',
      });
      expect(readFileSync(join(privateDirectory, '.gitignore'), 'utf8')).toBe('*\n');
      expect(
        JSON.parse(readFileSync(join(privateDirectory, 'config.json'), 'utf8')).repositoryId,
      ).toBe('fixture');
      writeFileSync(join(privateDirectory, '.gitignore'), '*\n# existing policy\n');
      ensurePrivateDirectory(privateDirectory);
      expect(readFileSync(join(privateDirectory, '.gitignore'), 'utf8')).toBe(
        '*\n# existing policy\n',
      );
    } finally {
      removeFixtureDirectory(directory);
    }
  });
});
