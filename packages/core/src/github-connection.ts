import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type {
  GitHubInstallation,
  GitHubRepository,
  GitHubUser,
  LocalContext,
} from '@memvora/contracts';
import { DomainError } from './local-service.js';

export type GitHubOAuthAttempt = {
  stateHash: string;
  browserHash: string;
  encryptedVerifier: string;
  configHash: string;
  expiresAt: number;
  expectedRevision: number;
};
export type GitHubConnectionRecord = {
  revision: number;
  configHash: string;
  user: GitHubUser;
  encryptedTokens: string;
  expiresAt: number | null;
  updatedAt: string;
};
export interface GitHubConnectionStore {
  githubConnectionRevision(context: LocalContext): number;
  beginGitHubOAuth(
    context: LocalContext,
    input: Omit<GitHubOAuthAttempt, 'expectedRevision'>,
  ): GitHubOAuthAttempt;
  consumeGitHubOAuth(
    context: LocalContext,
    stateHash: string,
    browserHash: string,
    configHash: string,
    now: number,
  ): GitHubOAuthAttempt;
  getGitHubConnection(context: LocalContext): GitHubConnectionRecord | null;
  saveGitHubConnection(
    context: LocalContext,
    input: Omit<GitHubConnectionRecord, 'revision' | 'updatedAt'>,
    expectedRevision: number,
  ): GitHubConnectionRecord;
  disconnectGitHub(context: LocalContext, expectedRevision?: number): void;
}
export type GitHubAppConfig = {
  appId: number;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};
export type GitHubTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
};
export interface GitHubOAuthProviderPort {
  authorizationUrl(state: string, verifier: string): string;
  exchange(code: string, verifier: string): Promise<GitHubTokenSet>;
  refresh(refreshToken: string): Promise<GitHubTokenSet>;
  user(accessToken: string): Promise<GitHubUser>;
  installations(
    accessToken: string,
    page?: number,
    timeoutMs?: number,
  ): Promise<{ items: GitHubInstallation[]; page: number; hasMore: boolean }>;
  repositories(
    accessToken: string,
    installationId: number,
    page?: number,
    timeoutMs?: number,
  ): Promise<{ items: GitHubRepository[]; page: number; hasMore: boolean }>;
  request(accessToken: string, path: string, timeoutMs?: number): Promise<unknown>;
}
export const githubHash = (value: string) => createHash('sha256').update(value).digest('hex');
const connectionChanged = () =>
  new DomainError(
    'GITHUB_CONNECTION_CHANGED',
    'The GitHub connection changed. Refresh and try again.',
    409,
  );

/** Local server-secret encryption. Rotating the local API secret requires reconnecting GitHub. */
export class GitHubCredentialCipher {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error('A configured local server secret is required.');
    this.key = Buffer.from(
      hkdfSync('sha256', secret, 'memvora-github-v1', 'credential-encryption', 32),
    );
  }
  private aad(context: LocalContext, purpose: string): Buffer {
    return Buffer.from(
      JSON.stringify([
        context.user.id,
        context.workspace.id,
        context.workspace.generation,
        purpose,
      ]),
    );
  }
  encrypt(context: LocalContext, purpose: string, value: string): string {
    if (Buffer.byteLength(value) > 40_000)
      throw new DomainError(
        'GITHUB_CREDENTIAL_INVALID',
        'GitHub credential exceeds the supported size.',
      );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(context, purpose));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      body.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }
  decrypt(context: LocalContext, purpose: string, value: string): string {
    try {
      if (value.length > 64 * 1024) throw new Error();
      const parts = value.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
      const values = parts.slice(1).map((part) => {
        const result = Buffer.from(part, 'base64url');
        if (result.toString('base64url') !== part) throw new Error();
        return result;
      });
      if (values[0]!.length !== 12 || values[2]!.length !== 16) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, values[0]!);
      cipher.setAAD(this.aad(context, purpose));
      cipher.setAuthTag(values[2]!);
      return Buffer.concat([cipher.update(values[1]!), cipher.final()]).toString('utf8');
    } catch {
      throw new DomainError(
        'GITHUB_RECONNECT_REQUIRED',
        'Reconnect GitHub to restore its server-side credential.',
        409,
      );
    }
  }
}

/** Personal-workspace connection flow; browser callbacks never become workspace login credentials. */
export class GitHubConnections {
  readonly configHash: string;
  private readonly cipher: GitHubCredentialCipher;
  private readonly refreshing = new Map<string, Promise<GitHubConnectionRecord>>();
  constructor(
    readonly store: GitHubConnectionStore,
    readonly config: GitHubAppConfig,
    readonly provider: GitHubOAuthProviderPort,
    secret: string,
  ) {
    this.configHash = githubHash(
      JSON.stringify([config.appId, config.clientId, config.callbackUrl]),
    );
    this.cipher = new GitHubCredentialCipher(secret);
  }
  record(context: LocalContext): GitHubConnectionRecord | null {
    const value = this.store.getGitHubConnection(context);
    return value?.configHash === this.configHash ? value : null;
  }
  assertCurrent(context: LocalContext, revision: number): void {
    if (this.record(context)?.revision !== revision) throw connectionChanged();
  }
  start(context: LocalContext, browserHash: string) {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 10 * 60_000;
    this.store.beginGitHubOAuth(context, {
      stateHash: githubHash(state),
      browserHash,
      configHash: this.configHash,
      encryptedVerifier: this.cipher.encrypt(context, `oauth:${this.configHash}`, verifier),
      expiresAt,
    });
    return {
      authorizationUrl: this.provider.authorizationUrl(state, verifier),
      expiresAt: new Date(expiresAt).toISOString(),
      callbackUrl: this.config.callbackUrl,
    };
  }
  async finish(
    context: LocalContext,
    input: { state: string; browserHash: string; code?: string; error?: string },
  ) {
    const attempt = this.store.consumeGitHubOAuth(
      context,
      githubHash(input.state),
      input.browserHash,
      this.configHash,
      Date.now(),
    );
    if (input.error) return { status: 'denied' as const, user: null };
    if (!input.code)
      throw new DomainError('INVALID_OAUTH_CALLBACK', 'A GitHub authorization code is required.');
    const verifier = this.cipher.decrypt(
      context,
      `oauth:${this.configHash}`,
      attempt.encryptedVerifier,
    );
    const tokens = await this.provider.exchange(input.code, verifier);
    const user = await this.provider.user(tokens.accessToken);
    const record = this.store.saveGitHubConnection(
      context,
      {
        configHash: this.configHash,
        user,
        encryptedTokens: this.cipher.encrypt(
          context,
          `tokens:${this.configHash}`,
          JSON.stringify(tokens),
        ),
        expiresAt: tokens.expiresAt,
      },
      attempt.expectedRevision,
    );
    return { status: 'connected' as const, user: record.user };
  }
  private tokens(context: LocalContext, record: GitHubConnectionRecord): GitHubTokenSet {
    try {
      const value = JSON.parse(
        this.cipher.decrypt(context, `tokens:${this.configHash}`, record.encryptedTokens),
      ) as GitHubTokenSet;
      const validToken = (item: unknown) =>
        typeof item === 'string' && item.length > 0 && item.length <= 16_384 && !/\s/.test(item);
      const validExpiry = (item: unknown) =>
        item === null || (typeof item === 'number' && Number.isSafeInteger(item) && item > 0);
      if (
        !validToken(value.accessToken) ||
        (value.refreshToken !== null && !validToken(value.refreshToken)) ||
        !validExpiry(value.expiresAt) ||
        !validExpiry(value.refreshExpiresAt)
      )
        throw new Error();
      return value;
    } catch {
      throw new DomainError(
        'GITHUB_RECONNECT_REQUIRED',
        'Reconnect GitHub to restore its server-side credential.',
        409,
      );
    }
  }
  private async access(
    context: LocalContext,
  ): Promise<{ record: GitHubConnectionRecord; token: string }> {
    let record = this.record(context);
    if (!record)
      throw new DomainError('GITHUB_NOT_CONNECTED', 'Connect this workspace to GitHub first.', 409);
    let tokens = this.tokens(context, record);
    if (tokens.expiresAt !== null && tokens.expiresAt <= Date.now() + 30_000) {
      if (
        !tokens.refreshToken ||
        (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= Date.now())
      )
        throw new DomainError(
          'GITHUB_AUTH_EXPIRED',
          'GitHub authorization expired. Reconnect to continue.',
          401,
        );
      const key = `${context.workspace.id}:${record.revision}`;
      let pending = this.refreshing.get(key);
      if (!pending) {
        const original = record;
        const refreshToken = tokens.refreshToken;
        pending = (async () => {
          const next = await this.provider.refresh(refreshToken);
          return this.store.saveGitHubConnection(
            context,
            {
              configHash: this.configHash,
              user: original.user,
              encryptedTokens: this.cipher.encrypt(
                context,
                `tokens:${this.configHash}`,
                JSON.stringify(next),
              ),
              expiresAt: next.expiresAt,
            },
            original.revision,
          );
        })();
        this.refreshing.set(key, pending);
      }
      try {
        record = await pending;
      } finally {
        if (this.refreshing.get(key) === pending) this.refreshing.delete(key);
      }
      tokens = this.tokens(context, record);
    }
    this.assertCurrent(context, record.revision);
    return { record, token: tokens.accessToken };
  }
  async run<T>(
    context: LocalContext,
    action: (token: string, record: GitHubConnectionRecord) => Promise<T>,
  ): Promise<T> {
    let used: GitHubConnectionRecord | undefined = this.record(context) ?? undefined;
    try {
      const access = await this.access(context);
      used = access.record;
      const result = await action(access.token, access.record);
      this.assertCurrent(context, access.record.revision);
      return result;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'GITHUB_AUTH_EXPIRED') {
        const revision = used?.revision;
        if (revision !== undefined) {
          try {
            this.store.disconnectGitHub(context, revision);
          } catch (changed) {
            if (!(changed instanceof DomainError && changed.code === 'GITHUB_CONNECTION_CHANGED'))
              throw changed;
          }
        }
      }
      throw error;
    }
  }
  remaining(deadline: number): number {
    const value = deadline - Date.now();
    if (value <= 0)
      throw new DomainError(
        'GITHUB_REMOTE_UNAVAILABLE',
        'The bounded GitHub request reached its time limit. Try again.',
        503,
        true,
      );
    return value;
  }
  async requireInstallation(
    token: string,
    installationId: number,
    deadline = Date.now() + 15_000,
  ): Promise<void> {
    for (let page = 1; page <= 10; page++) {
      const result = await this.provider.installations(token, page, this.remaining(deadline));
      if (
        result.items.some(
          (item) =>
            item.id === installationId && item.appId === this.config.appId && !item.suspended,
        )
      )
        return;
      if (!result.hasMore) break;
    }
    throw new DomainError(
      'GITHUB_ACCESS_DENIED',
      'This GitHub App installation is not available to the connected account.',
      403,
    );
  }
  async requireRepository(
    token: string,
    input: {
      installationId: number;
      repositoryId: number;
      repositoryPage: number;
      fullName: string;
    },
    deadline = Date.now() + 15_000,
  ): Promise<void> {
    await this.requireInstallation(token, input.installationId, deadline);
    const page = await this.provider.repositories(
      token,
      input.installationId,
      input.repositoryPage,
      this.remaining(deadline),
    );
    if (
      !page.items.some(
        (item) =>
          item.id === input.repositoryId &&
          item.fullName.toLowerCase() === input.fullName.toLowerCase(),
      )
    )
      throw new DomainError(
        'GITHUB_ACCESS_DENIED',
        'This repository is no longer on the selected authorized page. Refresh the GitHub list.',
        403,
      );
  }
}
