import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalContext, RepositoryContext } from '@memvora/contracts';
import { DomainError } from '@memvora/core';
import type { GitHubConnectionRecord, GitHubOAuthAttempt } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    if (!existsSync(directory)) continue;
    const target = realpathSync(resolve(directory));
    const prefix = join(temporaryRoot, 'memvora-github-');
    if (
      target === temporaryRoot ||
      dirname(target) !== temporaryRoot ||
      !target.startsWith(prefix) ||
      !basename(target).startsWith('memvora-github-')
    )
      throw new Error('Refusing to remove a temporary path outside this test target.');
    rmSync(target, { recursive: true, force: true });
  }
});
const open = (path = ':memory:') => {
  const store = new SqliteEvidenceStore(path);
  stores.push(store);
  return store;
};
function filePath() {
  const directory = mkdtempSync(join(temporaryRoot, 'memvora-github-'));
  temporaryDirectories.push(directory);
  return join(directory, 'server.sqlite');
}
const hash = (label: string) => createHash('sha256').update(label).digest('hex');
const attempt = (label = randomUUID()): Omit<GitHubOAuthAttempt, 'expectedRevision'> => ({
  stateHash: hash(`state:${label}`),
  browserHash: hash(`browser:${label}`),
  encryptedVerifier: `test-encrypted-verifier:${label}`,
  configHash: hash('client-configuration'),
  expiresAt: Date.now() + 60_000,
});
const connection = (userId = 12_345): Omit<GitHubConnectionRecord, 'revision' | 'updatedAt'> => ({
  configHash: hash('client-configuration'),
  user: {
    id: userId,
    login: 'developer',
    avatarUrl: 'https://avatars.githubusercontent.com/u/12345',
  },
  encryptedTokens: 'test-encrypted-token-envelope',
  expiresAt: null,
});
const consume = (
  store: SqliteEvidenceStore,
  context: LocalContext,
  input: Omit<GitHubOAuthAttempt, 'expectedRevision'>,
  time = Date.now(),
) => store.consumeGitHubOAuth(context, input.stateHash, input.browserHash, input.configHash, time);
function code(action: () => unknown, expected: string) {
  try {
    action();
    throw new Error('Expected the operation to be rejected.');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(expected);
  }
}

describe('durable scoped GitHub authorization', () => {
  it('does not consume another browser or configuration binding, then commits one-time consumption across restart', () => {
    const path = filePath();
    const store = open(path);
    const context = store.context();
    const input = attempt();
    expect(store.beginGitHubOAuth(context, input)).toEqual({ ...input, expectedRevision: 1 });
    code(
      () => consume(store, context, { ...input, browserHash: hash('wrong-browser') }),
      'INVALID_OAUTH_STATE',
    );
    code(
      () => consume(store, context, { ...input, configHash: hash('wrong-config') }),
      'INVALID_OAUTH_STATE',
    );
    code(
      () => consume(store, context, { ...input, stateHash: hash('unknown-state') }),
      'INVALID_OAUTH_STATE',
    );
    expect(consume(store, context, input)).toEqual({ ...input, expectedRevision: 1 });
    store.close();
    const reopened = open(path);
    code(() => consume(reopened, context, input), 'INVALID_OAUTH_STATE');
    expect(reopened.getGitHubConnection(context)).toBeNull();
  });

  it('rejects an expired or replaced attempt and permits only the newest pending flow', () => {
    const store = open();
    const context = store.context();
    const older = attempt();
    const newer = attempt();
    store.beginGitHubOAuth(context, older);
    store.beginGitHubOAuth(context, newer);
    code(() => consume(store, context, older), 'INVALID_OAUTH_STATE');
    code(() => consume(store, context, newer, newer.expiresAt), 'INVALID_OAUTH_STATE');
    expect(consume(store, context, newer, newer.expiresAt - 1).expectedRevision).toBe(2);
  });

  it('revalidates live ownership without consuming another workspace attempt', () => {
    const store = open(filePath());
    const context = store.context();
    const input = attempt();
    store.beginGitHubOAuth(context, input);
    const otherWorkspaceId = randomUUID();
    const database = new DatabaseSync(store.path);
    try {
      database
        .prepare('INSERT INTO local_workspaces(id,owner_user_id,name,created_at) VALUES(?,?,?,?)')
        .run(otherWorkspaceId, context.user.id, 'Another scope', new Date().toISOString());
    } finally {
      database.close();
    }
    const otherScope = { ...context, workspace: { ...context.workspace, id: otherWorkspaceId } };
    code(() => consume(store, otherScope, input), 'INVALID_OAUTH_STATE');
    code(
      () => consume(store, { ...context, user: { ...context.user, id: randomUUID() } }, input),
      'WORKSPACE_UNAVAILABLE',
    );
    expect(consume(store, context, input).stateHash).toBe(input.stateHash);
  });

  it('persists encrypted records and pending flows without changing their revision after restart', () => {
    const path = filePath();
    const store = open(path);
    const context = store.context();
    const record = store.saveGitHubConnection(context, connection(), 0);
    const pending = attempt();
    store.beginGitHubOAuth(context, pending);
    store.close();
    const reopened = open(path);
    expect(reopened.getGitHubConnection(context)).toEqual({ ...record, revision: 2 });
    expect(reopened.githubConnectionRevision(context)).toBe(2);
    expect(consume(reopened, context, pending).expectedRevision).toBe(2);
    expect(record.encryptedTokens).toBe('test-encrypted-token-envelope');
  });

  it('uses revision CAS for provider completion and disconnect and retains the numeric identity pin', () => {
    const store = open();
    const context = store.context();
    expect(store.githubConnectionRevision(context)).toBe(0);
    const saved = store.saveGitHubConnection(context, connection(), 0);
    expect(saved.revision).toBe(1);
    code(() => store.saveGitHubConnection(context, connection(), 0), 'GITHUB_CONNECTION_CHANGED');
    code(() => store.disconnectGitHub(context, 0), 'GITHUB_CONNECTION_CHANGED');
    expect(store.getGitHubConnection(context)).toEqual(saved);
    store.disconnectGitHub(context, 1);
    expect(store.getGitHubConnection(context)).toBeNull();
    expect(store.githubConnectionRevision(context)).toBe(2);
    code(
      () => store.saveGitHubConnection(context, connection(99_999), 2),
      'GITHUB_IDENTITY_MISMATCH',
    );
    const renamed = connection();
    renamed.user.login = 'renamed-account';
    expect(store.saveGitHubConnection(context, renamed, 2)).toMatchObject({
      revision: 3,
      user: { id: 12_345, login: 'renamed-account' },
    });
  });

  it('clears pending flows and fences an already consumed callback when disconnect happens during remote I/O', () => {
    const store = open();
    const context = store.context();
    const input = attempt();
    store.beginGitHubOAuth(context, input);
    const captured = consume(store, context, input);
    store.disconnectGitHub(context, captured.expectedRevision);
    code(
      () => store.saveGitHubConnection(context, connection(), captured.expectedRevision),
      'GITHUB_CONNECTION_CHANGED',
    );
    const next = attempt();
    store.beginGitHubOAuth(context, next);
    store.disconnectGitHub(context);
    code(() => consume(store, context, next), 'INVALID_OAUTH_STATE');
    expect(store.getGitHubConnection(context)).toBeNull();
  });

  it('fences an in-flight older callback when a new authorization begins without erasing the new flow', () => {
    const store = open();
    const context = store.context();
    const first = attempt();
    const second = attempt();
    store.beginGitHubOAuth(context, first);
    const captured = consume(store, context, first);
    const newest = store.beginGitHubOAuth(context, second);
    expect(newest.expectedRevision).toBe(captured.expectedRevision + 1);
    code(
      () => store.saveGitHubConnection(context, connection(), captured.expectedRevision),
      'GITHUB_CONNECTION_CHANGED',
    );
    const accepted = consume(store, context, second);
    expect(accepted).toEqual(newest);
    expect(
      store.saveGitHubConnection(context, connection(), accepted.expectedRevision).revision,
    ).toBe(3);
  });

  it('clears stale generation credentials and state while preserving the same local owner identity pin', () => {
    const store = open(filePath());
    const context = store.context();
    store.saveGitHubConnection(context, connection(), 0);
    const pending = attempt();
    store.beginGitHubOAuth(context, pending);
    const database = new DatabaseSync(store.path);
    try {
      database
        .prepare('UPDATE local_workspaces SET generation=generation+1 WHERE id=?')
        .run(context.workspace.id);
    } finally {
      database.close();
    }
    code(() => store.getGitHubConnection(context), 'WORKSPACE_UNAVAILABLE');
    const freshContext = store.context();
    expect(store.getGitHubConnection(freshContext)).toBeNull();
    expect(store.githubConnectionRevision(freshContext)).toBe(3);
    code(() => consume(store, freshContext, pending), 'INVALID_OAUTH_STATE');
    code(
      () => store.saveGitHubConnection(freshContext, connection(), 2),
      'GITHUB_CONNECTION_CHANGED',
    );
    code(
      () => store.saveGitHubConnection(freshContext, connection(99_999), 3),
      'GITHUB_IDENTITY_MISMATCH',
    );
    expect(store.saveGitHubConnection(freshContext, connection(), 3).revision).toBe(4);
  });

  it('purges encrypted credentials, identity pins and state atomically with workspace deletion', () => {
    const store = open(filePath());
    const context = store.context();
    store.saveGitHubConnection(context, connection(), 0);
    const pending = attempt();
    store.beginGitHubOAuth(context, pending);
    store.deleteWorkspace(context);
    code(() => store.getGitHubConnection(context), 'WORKSPACE_UNAVAILABLE');
    code(() => store.saveGitHubConnection(context, connection(), 1), 'WORKSPACE_UNAVAILABLE');
    const database = new DatabaseSync(store.path);
    try {
      expect(
        database.prepare('SELECT count(*) AS count FROM local_github_connections').get()?.['count'],
      ).toBe(0);
      expect(
        database.prepare('SELECT count(*) AS count FROM local_github_oauth_attempts').get()?.[
          'count'
        ],
      ).toBe(0);
    } finally {
      database.close();
    }
    store.close();
    code(() => open(store.path).context(), 'WORKSPACE_UNAVAILABLE');
  });

  it('upgrades schema5 and safely reopens idempotent older-version fixtures', () => {
    const path = filePath();
    const store = open(path);
    const context = store.context();
    const saved = store.saveGitHubConnection(context, connection(), 0);
    store.close();
    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA user_version=5');
    } finally {
      database.close();
    }
    const reopened = open(path);
    expect(reopened.getGitHubConnection(context)).toEqual(saved);
    reopened.close();
    const inspection = new DatabaseSync(path);
    try {
      expect(inspection.prepare('PRAGMA user_version').get()?.['user_version']).toBe(7);
    } finally {
      inspection.close();
    }
  });

  it('migrates a schema5 database without GitHub tables while retaining the existing local owner', () => {
    const path = filePath();
    const store = open(path);
    const context = store.context();
    const repository = store.createRepository(context, { name: 'Before OAuth' });
    store.close();
    const database = new DatabaseSync(path);
    try {
      database.exec(
        'DROP TABLE local_github_oauth_attempts; DROP TABLE local_github_connections; PRAGMA user_version=5',
      );
    } finally {
      database.close();
    }
    const reopened = open(path);
    expect(reopened.context()).toEqual(context);
    expect(reopened.getRepository(context, repository.id).name).toBe('Before OAuth');
    expect(reopened.githubConnectionRevision(context)).toBe(0);
    expect(reopened.saveGitHubConnection(context, connection(), 0).revision).toBe(1);
  });

  it('rejects malformed hashes, unsafe timestamps and oversized opaque fields before storing a flow', () => {
    const store = open();
    const context = store.context();
    const input = attempt();
    code(
      () => store.beginGitHubOAuth(context, { ...input, stateHash: 'raw-state-secret' }),
      'INVALID_OAUTH_STATE',
    );
    code(
      () => store.beginGitHubOAuth(context, { ...input, expiresAt: Number.MAX_SAFE_INTEGER + 1 }),
      'INVALID_OAUTH_STATE',
    );
    code(
      () => store.beginGitHubOAuth(context, { ...input, encryptedVerifier: 'x'.repeat(65_537) }),
      'INVALID_OAUTH_STATE',
    );
    code(
      () =>
        store.saveGitHubConnection(
          context,
          { ...connection(), encryptedTokens: 'x'.repeat(65_537) },
          0,
        ),
      'INVALID_GITHUB_CONNECTION',
    );
    code(
      () => store.saveGitHubConnection(context, connection(Number.MAX_SAFE_INTEGER + 1), 0),
      'INVALID_GITHUB_CONNECTION',
    );
    expect(store.githubConnectionRevision(context)).toBe(0);
    expect(store.getGitHubConnection(context)).toBeNull();
  });

  it('checks the captured GitHub revision inside the same transaction that commits imported versions', () => {
    const store = open(filePath());
    const context = store.context();
    const repository = store.createRepository(context, { name: 'Fenced GitHub import' });
    const snapshot = (text: string): RepositoryContext => ({
      provider: 'github',
      fullName: 'owner/fenced-import',
      defaultBranch: 'main',
      commitSha: null,
      importedAt: new Date().toISOString(),
      files: [{ path: 'src/index.ts', sha: 'a'.repeat(40), size: text.length, text }],
      issues: [],
      pullRequests: [],
    });
    const before = snapshot('export const priorImportNeedle = 1;');
    const after = snapshot('export const laterImportNeedle = 2;');
    code(
      () => store.saveRepositoryContext(context, repository.id, before, 1, 0),
      'GITHUB_CONNECTION_CHANGED',
    );
    expect(store.getRepositoryContext(context, repository.id)).toBeNull();
    const authorized = store.saveGitHubConnection(context, connection(), 0);
    store.saveRepositoryContext(context, repository.id, before, 1, authorized.revision);
    const priorSourceId = store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId;
    store.disconnectGitHub(context, authorized.revision);
    code(
      () => store.saveRepositoryContext(context, repository.id, after, 1, authorized.revision),
      'GITHUB_CONNECTION_CHANGED',
    );
    expect(store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId).toBe(
      priorSourceId,
    );
    expect(store.searchRepositorySources(context, { query: 'laterImportNeedle' })).toEqual([]);
    const inspection = new DatabaseSync(store.path);
    try {
      expect(
        inspection.prepare('SELECT count(*) AS count FROM local_repository_sources').get()?.[
          'count'
        ],
      ).toBe(1);
    } finally {
      inspection.close();
    }
    const reconnected = store.saveGitHubConnection(context, connection(), 2);
    store.saveRepositoryContext(context, repository.id, after, 1, reconnected.revision);
    expect(store.searchRepositorySources(context, { query: 'laterImportNeedle' })).toHaveLength(1);
    expect(store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId).not.toBe(
      priorSourceId,
    );
  });
});
