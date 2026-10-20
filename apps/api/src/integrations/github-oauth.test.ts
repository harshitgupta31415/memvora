import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DomainError,
  GitHubConnections,
  GitHubCredentialCipher,
  githubHash,
  LocalMemvora,
} from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from '../app.js';
import { registerGitHubRoutes } from './github.js';
import { configuredGitHubOAuth } from './github-oauth.js';
import { GitHubOAuthProvider } from './github-oauth-provider.js';
import { importGitHubContext } from './github-client.js';

const token = 'local-oauth-integration-fixture-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
const config = {
  appId: 111,
  clientId: 'Iv1.fixture',
  clientSecret: 'test-client-secret',
  callbackUrl: 'http://127.0.0.1:3000/api/github/oauth/callback',
};
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function setup() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = {
    id: 12,
    full_name: 'fixture-owner/oauth-test',
    name: 'oauth-test',
    private: true,
    description: 'Labeled OAuth integration fixture',
    default_branch: 'main',
    html_url: 'https://github.com/fixture-owner/oauth-test',
    permissions: { pull: true },
  };
  const user = {
    id: 123,
    login: 'fixture-owner',
    avatar_url: 'https://avatars.githubusercontent.com/u/123',
  };
  const tokenReply = () => ({
    access_token: 'fixture-access-token',
    token_type: 'bearer',
    scope: '',
    expires_in: 3600,
    refresh_token: 'fixture-refresh-token',
    refresh_token_expires_in: 86400,
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token')
      return json(tokenReply());
    if (url.origin !== 'https://api.github.com') throw new Error('Unexpected fixture origin.');
    if (url.pathname === '/user') return json(user);
    if (url.pathname === '/user/installations')
      return json({
        total_count: 1,
        installations: [
          {
            id: 7,
            app_id: 111,
            account: { login: 'fixture-owner' },
            repository_selection: 'selected',
            suspended_at: null,
          },
        ],
      });
    if (url.pathname === '/user/installations/7/repositories')
      return json({ total_count: 1, repositories: [repository] });
    if (url.pathname === '/repos/fixture-owner/oauth-test') return json(repository);
    if (url.pathname.endsWith('/commits/main'))
      return json({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } });
    if (url.pathname.includes('/git/trees/'))
      return json({
        tree: [{ type: 'blob', mode: '100644', path: 'fixture.ts', size: 29, sha: 'c'.repeat(40) }],
        truncated: false,
      });
    if (url.pathname.includes('/git/blobs/'))
      return json({
        encoding: 'base64',
        content: Buffer.from('export const oauthFixture = 1;').toString('base64'),
      });
    if (url.pathname.endsWith('/issues')) return json([]);
    throw new Error(`Unexpected fixture resource ${url.pathname}; ${init?.method}`);
  });
  const provider = new GitHubOAuthProvider(config, fetcher);
  const oauth = new GitHubConnections(store, config, provider, token);
  const app = buildApp({
    store,
    token,
    embeddedWorker: false,
    registerIntegrations: (instance, local) =>
      registerGitHubRoutes(instance, local, {
        requested: true,
        callbackUrl: config.callbackUrl,
        message: 'Labeled test-provider configuration.',
        connection: oauth,
      }),
  });
  apps.push(app);
  const browser = randomBytes(32).toString('base64url');
  const browserHash = githubHash(browser);
  const start = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/github/oauth/start',
      headers,
      payload: { browserHash },
    });
    expect(response.statusCode).toBe(200);
    const value = response.json<{ authorizationUrl: string }>();
    return new URL(value.authorizationUrl);
  };
  const finish = async (authorization: URL, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/github/oauth/finish',
      headers,
      payload: {
        state: authorization.searchParams.get('state'),
        browserHash,
        code: 'fixture-authorization-code',
        ...extra,
      },
    });
  const connect = async () => {
    const authorization = await start();
    const response = await finish(authorization);
    expect(response.statusCode).toBe(200);
    return authorization;
  };
  return {
    store,
    service,
    provider,
    oauth,
    app,
    fetcher,
    browserHash,
    start,
    finish,
    connect,
    tokenReply,
  };
}

describe('personal local GitHub App connection flow', () => {
  it('accepts App metadata without the optional coarse permissions field only through verified installation selection', async () => {
    const { app, fetcher, connect } = setup();
    await connect();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname !== '/repos/fixture-owner/oauth-test') return response;
      const value = (await response.json()) as Record<string, unknown>;
      delete value.permissions;
      return json(value);
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/github/import',
          headers,
          payload: { fullName: 'fixture-owner/oauth-test' },
        })
      ).statusCode,
    ).toBe(400);
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/github/import',
      headers,
      payload: {
        fullName: 'fixture-owner/oauth-test',
        installationId: 7,
        repositoryId: 12,
        repositoryPage: 1,
      },
    });
    expect(imported.statusCode).toBe(200);
    await expect(
      importGitHubContext('fixture-owner/oauth-test', async () => ({
        id: 12,
        full_name: 'fixture-owner/oauth-test',
        name: 'oauth-test',
        private: true,
        description: null,
        default_branch: 'main',
        html_url: 'https://github.com/fixture-owner/oauth-test',
      })),
    ).rejects.toThrow('unexpected response');
  });

  it('imports an authorized empty repository as an empty snapshot rather than a network failure', async () => {
    const { app, fetcher, connect } = setup();
    await connect();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) =>
      String(input).includes('/commits/')
        ? json({ message: 'Fixture repository is empty.' }, 409)
        : original(input, init),
    );
    const result = await app.inject({
      method: 'POST',
      url: '/v1/github/import',
      headers,
      payload: {
        fullName: 'fixture-owner/oauth-test',
        installationId: 7,
        repositoryId: 12,
        repositoryPage: 1,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      partial: false,
      context: { files: [], commitSha: null },
    });
  });

  it('rejects stale results using the revision of one current connection record', async () => {
    const { store, service, oauth, connect } = setup();
    await connect();
    const context = service.context();
    const old = store.getGitHubConnection(context)!;
    store.saveGitHubConnection(context, old, old.revision);
    vi.spyOn(store, 'githubConnectionRevision').mockReturnValue(old.revision);
    expect(() => oauth.assertCurrent(context, old.revision)).toThrow('connection changed');
  });

  it('keeps every OAuth API route authenticated and validates callback and origin inputs', async () => {
    const { app, start, finish, fetcher } = setup();
    for (const path of ['start', 'finish', 'disconnect'])
      expect(
        (await app.inject({ method: 'POST', url: `/v1/github/oauth/${path}`, payload: {} }))
          .statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/github/oauth/start',
          headers: { ...headers, origin: 'https://untrusted.example' },
          payload: { browserHash: 'a'.repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    const authorization = await start();
    const malformed = await finish(authorization, { error: 'access_denied' });
    expect(malformed.statusCode).toBe(400);
    const wrongBrowser = await finish(authorization, { browserHash: 'b'.repeat(64) });
    expect(wrongBrowser.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await finish(authorization)).statusCode).toBe(200);
    expect((await finish(authorization)).statusCode).toBe(400);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('/access_token')),
    ).toHaveLength(1);
  });

  it('uses PKCE, persists encrypted credentials, returns safe profile, lists verified installations and imports authorized files', async () => {
    const { app, fetcher, start, finish, store, service } = setup();
    const authorization = await start();
    const response = await finish(authorization);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'connected', user: { id: 123 } });
    const exchange = fetcher.mock.calls.find(([url]) => String(url).includes('/access_token'))!;
    const fields = new URLSearchParams(String(exchange[1]?.body));
    expect(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url')).toBe(
      authorization.searchParams.get('code_challenge'),
    );
    const stored = store.getGitHubConnection(service.context())!;
    expect(stored.encryptedTokens).not.toContain('fixture-access-token');
    expect(stored.encryptedTokens).not.toContain('fixture-refresh-token');
    const status = await app.inject({ method: 'GET', url: '/v1/github/status', headers });
    expect(status.json()).toMatchObject({
      available: true,
      mode: 'github_app',
      user: { id: 123 },
      oauth: { connected: true },
    });
    for (const secret of [
      'fixture-access-token',
      'fixture-refresh-token',
      'test-client-secret',
      'code_verifier',
    ])
      expect(status.body).not.toContain(secret);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/github/installations', headers })).json().items,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/github/repositories', headers })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/github/repositories?installationId=999',
          headers,
        })
      ).statusCode,
    ).toBe(403);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/github/repositories?installationId=7',
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({ id: 12, installationId: 7, accessPage: 1 });
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/github/import',
      headers,
      payload: {
        fullName: 'fixture-owner/oauth-test',
        installationId: 7,
        repositoryId: 99,
        repositoryPage: 1,
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(store.repositories(service.context())).toHaveLength(0);
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/github/import',
      headers,
      payload: {
        fullName: 'fixture-owner/oauth-test',
        installationId: 7,
        repositoryId: 12,
        repositoryPage: 1,
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().context.files[0].text).toContain('oauthFixture');
    expect(
      store.searchRepositorySources(service.context(), { query: 'oauthFixture' }),
    ).toHaveLength(1);
    const disconnect = await app.inject({
      method: 'POST',
      url: '/v1/github/oauth/disconnect',
      headers,
      payload: {},
    });
    expect(disconnect.statusCode).toBe(200);
    expect(store.getGitHubConnection(service.context())).toBeNull();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/github/status', headers })).json(),
    ).toMatchObject({ available: false, mode: 'github_app', oauth: { connected: false } });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/github/installations', headers })).statusCode,
    ).toBe(409);
    expect(
      store.searchRepositorySources(service.context(), { query: 'oauthFixture' }),
    ).toHaveLength(1);
  });

  it('consumes a denied callback once without contacting GitHub', async () => {
    const { start, finish, fetcher } = setup();
    const authorization = await start();
    const response = await finish(authorization, { code: undefined, error: 'access_denied' });
    expect(response.json()).toEqual({ status: 'denied', user: null });
    expect((await finish(authorization)).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serializes refresh rotation and stops revoked credentials without switching to CLI access', async () => {
    const { store, service, oauth, provider, app, connect } = setup();
    await connect();
    const current = store.getGitHubConnection(service.context())!;
    const cipher = new GitHubCredentialCipher(token);
    store.saveGitHubConnection(
      service.context(),
      {
        ...current,
        encryptedTokens: cipher.encrypt(
          service.context(),
          `tokens:${oauth.configHash}`,
          JSON.stringify({
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
            expiresAt: Date.now() + 1,
            refreshExpiresAt: Date.now() + 60_000,
          }),
        ),
        expiresAt: Date.now() + 1,
      },
      current.revision,
    );
    const refresh = vi.spyOn(provider, 'refresh').mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000,
    });
    const results = await Promise.all([
      oauth.run(service.context(), async (access) => access),
      oauth.run(service.context(), async (access) => access),
    ]);
    expect(results).toEqual(['new-access', 'new-access']);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.spyOn(provider, 'installations').mockRejectedValue(
      new DomainError('GITHUB_AUTH_EXPIRED', 'Fixture revoked credential.', 401),
    );
    expect(
      (await app.inject({ method: 'GET', url: '/v1/github/installations', headers })).statusCode,
    ).toBe(401);
    expect(store.getGitHubConnection(service.context())).toBeNull();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/github/status', headers })).json(),
    ).toMatchObject({ available: false, mode: 'github_app' });
  });

  it('does not let a rejected old refresh disconnect a replacement connection', async () => {
    const { store, service, oauth, provider, connect } = setup();
    await connect();
    const context = service.context();
    const current = store.getGitHubConnection(context)!;
    const cipher = new GitHubCredentialCipher(token);
    store.saveGitHubConnection(
      context,
      {
        ...current,
        encryptedTokens: cipher.encrypt(
          context,
          `tokens:${oauth.configHash}`,
          JSON.stringify({
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
            expiresAt: Date.now() + 1,
            refreshExpiresAt: Date.now() + 60_000,
          }),
        ),
        expiresAt: Date.now() + 1,
      },
      current.revision,
    );
    let rejectRefresh!: (error: Error) => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    vi.spyOn(provider, 'refresh').mockImplementation(() => {
      notify();
      return new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      });
    });
    const attempt = oauth.run(context, async (access) => access).catch((error) => error);
    await started;
    store.disconnectGitHub(context);
    await connect();
    const replacement = store.getGitHubConnection(context)!;
    rejectRefresh(new DomainError('GITHUB_AUTH_EXPIRED', 'Old fixture refresh was revoked.', 401));
    expect(await attempt).toBeInstanceOf(DomainError);
    expect(store.getGitHubConnection(context)?.revision).toBe(replacement.revision);
  });

  it('fences an import when disconnect occurs during a remote file read', async () => {
    const { store, service, app, fetcher, connect } = setup();
    await connect();
    const original = fetcher.getMockImplementation()!;
    let release!: (response: Response) => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes('/git/blobs/')) {
        notify();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return original(input, init);
    });
    const importing = app
      .inject({
        method: 'POST',
        url: '/v1/github/import',
        headers,
        payload: {
          fullName: 'fixture-owner/oauth-test',
          installationId: 7,
          repositoryId: 12,
          repositoryPage: 1,
        },
      })
      .then((response) => response);
    await started;
    store.disconnectGitHub(service.context());
    release(
      json({
        encoding: 'base64',
        content: Buffer.from('export const staleOAuthFile = true;').toString('base64'),
      }),
    );
    expect((await importing).statusCode).toBe(409);
    expect(store.repositories(service.context())).toHaveLength(0);
  });

  it('binds encrypted data to server secret, workspace generation and purpose; invalid config fails closed', () => {
    const { store, service } = setup();
    const context = service.context();
    const cipher = new GitHubCredentialCipher(token);
    const encrypted = cipher.encrypt(context, 'tokens:fixture', 'private-fixture');
    expect(cipher.decrypt(context, 'tokens:fixture', encrypted)).toBe('private-fixture');
    expect(() => cipher.decrypt(context, 'oauth:fixture', encrypted)).toThrow('Reconnect');
    expect(() =>
      new GitHubCredentialCipher('different-secret'.repeat(4)).decrypt(
        context,
        'tokens:fixture',
        encrypted,
      ),
    ).toThrow('Reconnect');
    expect(() =>
      cipher.decrypt(
        { ...context, workspace: { ...context.workspace, generation: 2 } },
        'tokens:fixture',
        encrypted,
      ),
    ).toThrow('Reconnect');
    for (const name of [
      'GITHUB_APP_ID',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_CALLBACK_URL',
    ])
      vi.stubEnv(name, '');
    expect(configuredGitHubOAuth(store, token).requested).toBe(false);
    vi.stubEnv('GITHUB_CLIENT_ID', 'Iv1.fixture');
    expect(configuredGitHubOAuth(store, token).requested).toBe(true);
    expect(configuredGitHubOAuth(store, token).connection).toBeUndefined();
    vi.stubEnv('GITHUB_APP_ID', '111');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'fixture-secret');
    vi.stubEnv('GITHUB_CALLBACK_URL', 'https://untrusted.example/api/github/oauth/callback');
    expect(configuredGitHubOAuth(store, token).connection).toBeUndefined();
  });
});
