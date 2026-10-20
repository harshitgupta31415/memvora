import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { LocalContext } from '@memvora/contracts';
import { DomainError } from '@memvora/core';
import type { GitHubConnectionRecord, GitHubOAuthAttempt } from '@memvora/core';

type Row = Record<string, SQLOutputValue>;
type Access = {
  database: DatabaseSync;
  transaction<T>(action: () => T): T;
  requireContext(context: LocalContext): void;
};
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const opaque = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 65_536;
const invalidState = () =>
  new DomainError(
    'INVALID_OAUTH_STATE',
    'The GitHub authorization attempt is invalid or expired.',
    400,
  );
const changed = () =>
  new DomainError('GITHUB_CONNECTION_CHANGED', 'The GitHub connection changed. Start again.', 409);
const invalidConnection = () =>
  new DomainError('INVALID_GITHUB_CONNECTION', 'The GitHub connection data is invalid.', 400);

/** Private persistence helper. Encryption and provider requests belong to the server adapter. */
export class GitHubConnections {
  constructor(private readonly access: Access) {}

  /** Must run inside the shared write transaction, after authenticating the live scope. */
  private row(context: LocalContext): Row {
    this.access.requireContext(context);
    const database = this.access.database;
    let row = database
      .prepare('SELECT * FROM local_github_connections WHERE workspace_id=?')
      .get(context.workspace.id);
    if (!row) {
      database
        .prepare(
          'INSERT INTO local_github_connections(workspace_id,user_id,workspace_generation,revision) VALUES(?,?,?,0)',
        )
        .run(context.workspace.id, context.user.id, context.workspace.generation);
    } else if (
      row['user_id'] !== context.user.id ||
      Number(row['workspace_generation']) !== context.workspace.generation
    ) {
      const revision = this.nextRevision(row);
      const sameOwner = row['user_id'] === context.user.id;
      database
        .prepare(
          'UPDATE local_github_connections SET user_id=?,workspace_generation=?,revision=?,github_user_id=?,github_user_json=?,config_hash=NULL,encrypted_tokens=NULL,expires_at=NULL,updated_at=? WHERE workspace_id=?',
        )
        .run(
          context.user.id,
          context.workspace.generation,
          revision,
          sameOwner ? row['github_user_id']! : null,
          sameOwner ? row['github_user_json']! : null,
          new Date().toISOString(),
          context.workspace.id,
        );
      this.clearAttempt(context);
    }
    row = database
      .prepare('SELECT * FROM local_github_connections WHERE workspace_id=?')
      .get(context.workspace.id);
    if (!row) throw changed();
    return row;
  }

  private nextRevision(row: Row): number {
    const revision = Number(row['revision']);
    if (!safeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) throw changed();
    return revision + 1;
  }

  private clearAttempt(context: LocalContext): void {
    this.access.database
      .prepare('DELETE FROM local_github_oauth_attempts WHERE workspace_id=?')
      .run(context.workspace.id);
  }

  private record(row: Row): GitHubConnectionRecord | null {
    if (row['encrypted_tokens'] == null) return null;
    return {
      revision: Number(row['revision']),
      configHash: String(row['config_hash']),
      user: JSON.parse(String(row['github_user_json'])) as GitHubConnectionRecord['user'],
      encryptedTokens: String(row['encrypted_tokens']),
      expiresAt: row['expires_at'] == null ? null : Number(row['expires_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  revision(context: LocalContext): number {
    return this.access.transaction(() => Number(this.row(context)['revision']));
  }

  begin(
    context: LocalContext,
    input: Omit<GitHubOAuthAttempt, 'expectedRevision'>,
  ): GitHubOAuthAttempt {
    if (
      !input ||
      !hash(input.stateHash) ||
      !hash(input.browserHash) ||
      !hash(input.configHash) ||
      !opaque(input.encryptedVerifier) ||
      !safeInteger(input.expiresAt) ||
      input.expiresAt <= Date.now()
    )
      throw invalidState();
    return this.access.transaction(() => {
      // A new flow fences callbacks already exchanging a previously consumed code.
      const expectedRevision = this.nextRevision(this.row(context));
      this.access.database
        .prepare('UPDATE local_github_connections SET revision=? WHERE workspace_id=?')
        .run(expectedRevision, context.workspace.id);
      this.access.database
        .prepare(
          'INSERT INTO local_github_oauth_attempts(workspace_id,user_id,workspace_generation,state_hash,browser_hash,encrypted_verifier,config_hash,expires_at,expected_revision) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET user_id=excluded.user_id,workspace_generation=excluded.workspace_generation,state_hash=excluded.state_hash,browser_hash=excluded.browser_hash,encrypted_verifier=excluded.encrypted_verifier,config_hash=excluded.config_hash,expires_at=excluded.expires_at,expected_revision=excluded.expected_revision',
        )
        .run(
          context.workspace.id,
          context.user.id,
          context.workspace.generation,
          input.stateHash,
          input.browserHash,
          input.encryptedVerifier,
          input.configHash,
          input.expiresAt,
          expectedRevision,
        );
      return {
        stateHash: input.stateHash,
        browserHash: input.browserHash,
        encryptedVerifier: input.encryptedVerifier,
        configHash: input.configHash,
        expiresAt: input.expiresAt,
        expectedRevision,
      };
    });
  }

  consume(
    context: LocalContext,
    stateHash: string,
    browserHash: string,
    configHash: string,
    now: number,
  ): GitHubOAuthAttempt {
    if (!hash(stateHash) || !hash(browserHash) || !hash(configHash) || !safeInteger(now))
      throw invalidState();
    return this.access.transaction(() => {
      const connection = this.row(context);
      const attempt = this.access.database
        .prepare(
          'SELECT * FROM local_github_oauth_attempts WHERE workspace_id=? AND user_id=? AND workspace_generation=? AND state_hash=? AND browser_hash=? AND config_hash=? AND expected_revision=? AND expires_at>?',
        )
        .get(
          context.workspace.id,
          context.user.id,
          context.workspace.generation,
          stateHash,
          browserHash,
          configHash,
          Number(connection['revision']),
          now,
        );
      if (!attempt) throw invalidState();
      // Commit this deletion before exchanging the authorization code over the network.
      this.clearAttempt(context);
      return {
        stateHash: String(attempt['state_hash']),
        browserHash: String(attempt['browser_hash']),
        encryptedVerifier: String(attempt['encrypted_verifier']),
        configHash: String(attempt['config_hash']),
        expiresAt: Number(attempt['expires_at']),
        expectedRevision: Number(attempt['expected_revision']),
      };
    });
  }

  get(context: LocalContext): GitHubConnectionRecord | null {
    return this.access.transaction(() => this.record(this.row(context)));
  }

  save(
    context: LocalContext,
    input: Omit<GitHubConnectionRecord, 'revision' | 'updatedAt'>,
    expectedRevision: number,
  ): GitHubConnectionRecord {
    if (
      !input ||
      !safeInteger(expectedRevision) ||
      !hash(input.configHash) ||
      !opaque(input.encryptedTokens) ||
      (input.expiresAt !== null && !safeInteger(input.expiresAt)) ||
      !input.user ||
      !safeInteger(input.user.id) ||
      input.user.id === 0 ||
      typeof input.user.login !== 'string' ||
      !input.user.login.length ||
      input.user.login.length > 100 ||
      typeof input.user.avatarUrl !== 'string' ||
      input.user.avatarUrl.length > 2_048
    )
      throw invalidConnection();
    return this.access.transaction(() => {
      const row = this.row(context);
      if (Number(row['revision']) !== expectedRevision) throw changed();
      if (row['github_user_id'] != null && Number(row['github_user_id']) !== input.user.id)
        throw new DomainError(
          'GITHUB_IDENTITY_MISMATCH',
          'This local owner is already bound to a different GitHub account.',
          409,
        );
      const revision = this.nextRevision(row);
      const updatedAt = new Date().toISOString();
      const user = { id: input.user.id, login: input.user.login, avatarUrl: input.user.avatarUrl };
      this.access.database
        .prepare(
          'UPDATE local_github_connections SET revision=?,github_user_id=?,github_user_json=?,config_hash=?,encrypted_tokens=?,expires_at=?,updated_at=? WHERE workspace_id=?',
        )
        .run(
          revision,
          input.user.id,
          JSON.stringify(user),
          input.configHash,
          input.encryptedTokens,
          input.expiresAt,
          updatedAt,
          context.workspace.id,
        );
      this.clearAttempt(context);
      return {
        configHash: input.configHash,
        user,
        encryptedTokens: input.encryptedTokens,
        expiresAt: input.expiresAt,
        revision,
        updatedAt,
      };
    });
  }

  disconnect(context: LocalContext, expectedRevision?: number): void {
    if (expectedRevision !== undefined && !safeInteger(expectedRevision)) throw changed();
    this.access.transaction(() => {
      const row = this.row(context);
      if (expectedRevision !== undefined && Number(row['revision']) !== expectedRevision)
        throw changed();
      this.access.database
        .prepare(
          'UPDATE local_github_connections SET revision=?,config_hash=NULL,encrypted_tokens=NULL,expires_at=NULL,updated_at=? WHERE workspace_id=?',
        )
        .run(this.nextRevision(row), new Date().toISOString(), context.workspace.id);
      this.clearAttempt(context);
    });
  }
}
