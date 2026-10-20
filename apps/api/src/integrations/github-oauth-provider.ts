import { createHash } from 'node:crypto';
import { DomainError } from '@memvora/core';
import type { GitHubRepository, GitHubUser } from './github-client.js';

export type GitHubOAuthConfig = {
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
export type GitHubInstallation = {
  id: number;
  accountLogin: string;
  appId: number;
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
};
export type GitHubRepoList = { items: GitHubRepository[]; page: number; hasMore: boolean };

const authorizeEndpoint = 'https://github.com/login/oauth/authorize';
const tokenEndpoint = 'https://github.com/login/oauth/access_token';
const apiOrigin = 'https://api.github.com';
const pageSize = 30;
const apiBytes = 4 * 1024 * 1024;
const tokenBytes = 64 * 1024;
const maxTimeoutMs = 15_000;

const unavailable = () =>
  new DomainError(
    'GITHUB_REMOTE_UNAVAILABLE',
    'GitHub could not complete the request. Try again or review the configured connection.',
    503,
    true,
  );
const expired = () =>
  new DomainError(
    'GITHUB_AUTH_EXPIRED',
    'GitHub authorization is unavailable or expired. Reconnect your account.',
    401,
  );
const denied = () =>
  new DomainError('GITHUB_ACCESS_DENIED', 'GitHub has not granted access to this resource.', 403);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 2048, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (!allowEmpty && value.length === 0) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw unavailable();
  return value;
}
function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw unavailable();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}
function pageNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw denied();
  return value;
}
function opaque(value: string, maximum = 16_384): string {
  const checked = text(value, maximum);
  if (/\s/u.test(checked)) throw unavailable();
  return checked;
}
function verifier(value: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(value)) throw denied();
  return value;
}
function expiry(value: unknown, at: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 315_360_000)
    throw unavailable();
  return at + value * 1000;
}
function repository(value: unknown): GitHubRepository {
  const raw = object(value);
  const fullName = text(raw['full_name'], 220);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName) ||
    fullName.split('/').some((part) => part === '.' || part === '..')
  )
    throw unavailable();
  let url: URL;
  try {
    url = new URL(text(raw['html_url']));
  } catch {
    throw unavailable();
  }
  if (
    url.origin !== 'https://github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/u, '').toLowerCase() !== `/${fullName}`.toLowerCase()
  )
    throw unavailable();
  if (typeof raw['private'] !== 'boolean') throw unavailable();
  const description = raw['description'];
  if (description !== null && typeof description !== 'string') throw unavailable();
  return {
    id: positiveId(raw['id']),
    fullName,
    name: text(raw['name'], 200),
    private: raw['private'],
    description: description === null ? null : text(description, 4000, true),
    defaultBranch: text(raw['default_branch'], 200, true),
    url: url.toString(),
  };
}

/** Fixed public GitHub endpoints; a transport can be injected only by application tests. */
export class GitHubOAuthProvider {
  private readonly config: GitHubOAuthConfig;
  constructor(
    config: GitHubOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    positiveId(config.appId);
    opaque(config.clientId, 256);
    opaque(config.clientSecret, 4096);
    let callback: URL;
    try {
      callback = new URL(config.callbackUrl);
    } catch {
      throw unavailable();
    }
    if (
      !['http:', 'https:'].includes(callback.protocol) ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash
    )
      throw unavailable();
    if (
      callback.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname)
    )
      throw unavailable();
    this.config = { ...config, callbackUrl: callback.toString() };
  }

  authorizationUrl(state: string, codeVerifier: string): string {
    const url = new URL(authorizeEndpoint);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      state: opaque(state, 512),
      code_challenge: createHash('sha256').update(verifier(codeVerifier)).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'offline_access',
    }).toString();
    return url.toString();
  }

  async exchange(code: string, codeVerifier: string): Promise<GitHubTokenSet> {
    return this.tokenRequest({
      code: opaque(code, 2048),
      code_verifier: verifier(codeVerifier),
      redirect_uri: this.config.callbackUrl,
    });
  }

  async refresh(refreshToken: string): Promise<GitHubTokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: opaque(refreshToken) });
  }

  async user(accessToken: string): Promise<GitHubUser> {
    const value = object(await this.request(accessToken, '/user'));
    const login = text(value['login'], 100);
    if (!/^[A-Za-z0-9_.-]+$/u.test(login)) throw unavailable();
    let avatar: URL;
    try {
      avatar = new URL(text(value['avatar_url']));
    } catch {
      throw unavailable();
    }
    if (avatar.protocol !== 'https:' || avatar.username || avatar.password) throw unavailable();
    return { id: positiveId(value['id']), login, avatarUrl: avatar.toString() };
  }

  async installations(
    accessToken: string,
    page = 1,
    timeoutMs = maxTimeoutMs,
  ): Promise<{ items: GitHubInstallation[]; page: number; hasMore: boolean }> {
    const checkedPage = pageNumber(page);
    const value = object(
      await this.request(
        accessToken,
        `/user/installations?per_page=${pageSize}&page=${checkedPage}`,
        timeoutMs,
      ),
    );
    if (!Array.isArray(value['installations']) || value['installations'].length > pageSize)
      throw unavailable();
    const total = count(value['total_count']);
    const rawItems = value['installations'];
    const items: GitHubInstallation[] = [];
    for (const entry of rawItems) {
      const installation = object(entry);
      const id = positiveId(installation['id']);
      const appId = positiveId(installation['app_id']);
      const selection = installation['repository_selection'];
      if (selection !== 'all' && selection !== 'selected') throw unavailable();
      const suspendedAt = installation['suspended_at'];
      if (suspendedAt !== null && typeof suspendedAt !== 'string') throw unavailable();
      const accountLogin = text(object(installation['account'])['login'], 100);
      if (appId !== this.config.appId || suspendedAt !== null) continue;
      items.push({ id, accountLogin, appId, repositorySelection: selection, suspended: false });
    }
    return {
      items,
      page: checkedPage,
      hasMore: rawItems.length === pageSize && checkedPage * pageSize < total,
    };
  }

  async repositories(
    accessToken: string,
    installationId: number,
    page = 1,
    timeoutMs = maxTimeoutMs,
  ): Promise<GitHubRepoList> {
    const checkedPage = pageNumber(page);
    const id = positiveId(installationId);
    const value = object(
      await this.request(
        accessToken,
        `/user/installations/${id}/repositories?per_page=${pageSize}&page=${checkedPage}`,
        timeoutMs,
      ),
    );
    if (!Array.isArray(value['repositories']) || value['repositories'].length > pageSize)
      throw unavailable();
    const total = count(value['total_count']);
    return {
      items: value['repositories'].map(repository),
      page: checkedPage,
      hasMore: value['repositories'].length === pageSize && checkedPage * pageSize < total,
    };
  }

  async request(accessToken: string, path: string, timeoutMs = maxTimeoutMs): Promise<unknown> {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\\#\u0000-\u0020\u007f]/u.test(path) ||
      path.includes('://')
    )
      throw denied();
    const url = new URL(path, apiOrigin);
    if (url.origin !== apiOrigin || url.username || url.password || url.hash) throw denied();
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw unavailable();
    return this.json(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${opaque(accessToken)}`,
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'Memvora-local',
        },
      },
      apiBytes,
      Math.min(timeoutMs, maxTimeoutMs),
    );
  }

  private async tokenRequest(fields: Record<string, string>): Promise<GitHubTokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      ...fields,
    });
    const result = object(
      await this.json(
        new URL(tokenEndpoint),
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Memvora-local',
          },
          body: body.toString(),
        },
        tokenBytes,
        maxTimeoutMs,
      ),
    );
    if (result['error'] !== undefined) {
      if (
        ['bad_refresh_token', 'bad_verification_code', 'expired_token'].includes(
          String(result['error']),
        )
      )
        throw expired();
      if (result['error'] === 'access_denied') throw denied();
      throw unavailable();
    }
    if (result['token_type'] !== 'bearer' || result['scope'] !== '') throw unavailable();
    const accessToken = opaque(text(result['access_token'], 16_384));
    const hasExpiry = result['expires_in'] !== undefined;
    const hasRefresh = result['refresh_token'] !== undefined;
    const hasRefreshExpiry = result['refresh_token_expires_in'] !== undefined;
    if (hasExpiry !== hasRefresh || hasExpiry !== hasRefreshExpiry) throw unavailable();
    if (!hasExpiry)
      return { accessToken, refreshToken: null, expiresAt: null, refreshExpiresAt: null };
    const at = Date.now();
    return {
      accessToken,
      refreshToken: opaque(text(result['refresh_token'], 16_384)),
      expiresAt: expiry(result['expires_in'], at),
      refreshExpiresAt: expiry(result['refresh_token_expires_in'], at),
    };
  }

  private async json(
    url: URL,
    init: RequestInit,
    maximumBytes: number,
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (
          response.status === 409 &&
          init.method === 'GET' &&
          /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+$/u.test(url.pathname)
        )
          throw new DomainError(
            'GITHUB_REPOSITORY_EMPTY',
            'GitHub reports no commit history for this repository.',
            409,
          );
        if (response.status === 401) throw expired();
        const rateLimited =
          response.status === 429 ||
          response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after');
        if ((response.status === 403 && !rateLimited) || response.status === 404) throw denied();
        throw unavailable();
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        await response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      if (!response.body) throw unavailable();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => {});
          throw unavailable();
        }
        chunks.push(chunk.value);
      }
      const content = new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks));
      return JSON.parse(content) as unknown;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw unavailable();
    }
  }
}
