import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubOAuthProvider, type GitHubOAuthConfig } from './github-oauth-provider.js';

const config: GitHubOAuthConfig = {
  appId: 42,
  clientId: 'fixture-client-id',
  clientSecret: 'fixture-client-secret-not-real',
  callbackUrl: 'http://127.0.0.1:3000/api/github/oauth/callback',
};
const verifier = 'v'.repeat(43);
const token = 'fixture-user-access-token-not-real';
const json = (body: unknown, status = 200, extraHeaders?: HeadersInit) => {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
};
const tokenResponse = (suffix = 'first') => ({
  access_token: `fixture-access-${suffix}`,
  refresh_token: `fixture-refresh-${suffix}`,
  expires_in: 28_800,
  refresh_token_expires_in: 15_897_600,
  token_type: 'bearer',
  scope: '',
});
const installation = (id: number, appId = 42, suspended_at: string | null = null) => ({
  id,
  app_id: appId,
  account: { login: `fixture-owner-${id}` },
  repository_selection: 'selected',
  suspended_at,
});
const repository = (id: number) => ({
  id,
  full_name: `fixture-owner/repository-${id}`,
  name: `repository-${id}`,
  private: true,
  description: null,
  default_branch: 'main',
  html_url: `https://github.com/fixture-owner/repository-${id}`,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitHub App OAuth provider HTTP adapter', () => {
  it('builds an exact callback authorization with S256 and offline_access without a secret in its URL', () => {
    const provider = new GitHubOAuthProvider(config, vi.fn<typeof fetch>());
    const url = new URL(provider.authorizationUrl('fixture-random-state', verifier));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('state')).toBe('fixture-random-state');
    expect(url.searchParams.get('redirect_uri')).toBe(config.callbackUrl);
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('scope')).toBe('offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
    expect(url.toString()).not.toContain(config.clientSecret);
    expect(url.searchParams.has('code_verifier')).toBe(false);
    expect(() => provider.authorizationUrl('fixture-state', 'too-short')).toThrow();
  });

  it('exchanges and refreshes in POST bodies, derives expiry timestamps and rejects transport redirects', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const transport = vi.fn<typeof fetch>(async () => json(tokenResponse()));
    const provider = new GitHubOAuthProvider(config, transport);
    const result = await provider.exchange('fixture-authorization-code', verifier);
    expect(result).toEqual({
      accessToken: 'fixture-access-first',
      refreshToken: 'fixture-refresh-first',
      expiresAt: 1_000_000 + 28_800_000,
      refreshExpiresAt: 1_000_000 + 15_897_600_000,
    });
    const [url, options] = transport.mock.calls[0]!;
    expect(String(url)).toBe('https://github.com/login/oauth/access_token');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(options?.headers).get('accept')).toBe('application/json');
    const body = new URLSearchParams(String(options?.body));
    expect(body.get('client_secret')).toBe(config.clientSecret);
    expect(body.get('code')).toBe('fixture-authorization-code');
    expect(body.get('code_verifier')).toBe(verifier);
    expect(body.get('redirect_uri')).toBe(config.callbackUrl);
    expect(String(url)).not.toContain('fixture');
    transport.mockImplementationOnce(async () => json(tokenResponse('rotated')));
    const rotated = await provider.refresh(result.refreshToken!);
    expect(rotated.accessToken).toBe('fixture-access-rotated');
    expect(rotated.refreshToken).toBe('fixture-refresh-rotated');
    const refreshBody = new URLSearchParams(String(transport.mock.calls[1]![1]?.body));
    expect(refreshBody.get('grant_type')).toBe('refresh_token');
    expect(refreshBody.get('refresh_token')).toBe('fixture-refresh-first');
    expect(refreshBody.has('code')).toBe(false);
    expect(refreshBody.has('code_verifier')).toBe(false);
  });

  it('handles documented nonexpiring tokens but rejects incomplete token tuples and OAuth-App scopes', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      json({ access_token: 'fixture-nonexpiring', scope: '', token_type: 'bearer' }),
    );
    const provider = new GitHubOAuthProvider(config, transport);
    expect(await provider.exchange('fixture-code', verifier)).toEqual({
      accessToken: 'fixture-nonexpiring',
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
    });
    for (const body of [
      { access_token: 'fixture-access', token_type: 'bearer', scope: '', expires_in: 28_800 },
      { ...tokenResponse(), expires_in: -1 },
      { ...tokenResponse(), refresh_token: '' },
      { ...tokenResponse(), scope: 'repo' },
      { ...tokenResponse(), token_type: 'unknown' },
    ]) {
      transport.mockImplementationOnce(async () => json(body));
      await expect(provider.exchange('fixture-code', verifier)).rejects.toMatchObject({
        code: 'GITHUB_REMOTE_UNAVAILABLE',
        statusCode: 503,
      });
    }
  });

  it('validates the stable user identity and only exposes active installations of the configured App', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      json({
        id: 123,
        login: 'fixture-user',
        avatar_url: 'https://avatars.githubusercontent.com/u/123',
      }),
    );
    const provider = new GitHubOAuthProvider(config, transport);
    expect(await provider.user(token)).toEqual({
      id: 123,
      login: 'fixture-user',
      avatarUrl: 'https://avatars.githubusercontent.com/u/123',
    });
    expect(new Headers(transport.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    const items = Array.from({ length: 30 }, (_value, index) => installation(index + 1));
    items[0] = installation(1, 99);
    items[1] = installation(2, 42, '2026-10-21T09:00:00Z');
    transport.mockImplementationOnce(async () => json({ installations: items, total_count: 31 }));
    const result = await provider.installations(token);
    expect(result.items).toHaveLength(28);
    expect(result.items.every((entry) => entry.appId === 42 && !entry.suspended)).toBe(true);
    expect(result.hasMore).toBe(true);
    transport.mockImplementationOnce(async () =>
      json({
        id: 'not-a-numeric-id',
        login: 'fixture-user',
        avatar_url: 'https://avatars.githubusercontent.com/u/123',
      }),
    );
    await expect(provider.user(token)).rejects.toMatchObject({ code: 'GITHUB_REMOTE_UNAVAILABLE' });
  });

  it('lists repositories through the user-installation intersection and rejects untrusted API targets', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      json({ repositories: [repository(5)], total_count: 1 }),
    );
    const provider = new GitHubOAuthProvider(config, transport);
    const result = await provider.repositories(token, 7);
    expect(result.items[0]).toMatchObject({
      id: 5,
      fullName: 'fixture-owner/repository-5',
      private: true,
    });
    expect(String(transport.mock.calls[0]![0])).toBe(
      'https://api.github.com/user/installations/7/repositories?per_page=30&page=1',
    );
    expect(transport.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'error' });
    for (const path of [
      'https://attacker.example/steal',
      '//attacker.example/steal',
      '/\\attacker.example/steal',
      '/user#fragment',
    ]) {
      await expect(provider.request(token, path)).rejects.toMatchObject({
        code: 'GITHUB_ACCESS_DENIED',
        statusCode: 403,
      });
    }
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockImplementationOnce(async () =>
      json({
        repositories: [{ ...repository(5), html_url: 'https://attacker.example/fixture' }],
        total_count: 1,
      }),
    );
    await expect(provider.repositories(token, 7)).rejects.toMatchObject({
      code: 'GITHUB_REMOTE_UNAVAILABLE',
    });
  });

  it('maps failures safely, including HTTP200 OAuth errors, without echoing response tokens or errors', async () => {
    const transport = vi.fn<typeof fetch>();
    const provider = new GitHubOAuthProvider(config, transport);
    const scenarios = [
      { status: 401, expected: 'GITHUB_AUTH_EXPIRED' },
      { status: 403, expected: 'GITHUB_ACCESS_DENIED' },
      { status: 404, expected: 'GITHUB_ACCESS_DENIED' },
      { status: 429, expected: 'GITHUB_REMOTE_UNAVAILABLE' },
      { status: 500, expected: 'GITHUB_REMOTE_UNAVAILABLE' },
    ];
    for (const scenario of scenarios) {
      transport.mockImplementationOnce(async () =>
        json({ message: `private upstream detail ${token}` }, scenario.status),
      );
      try {
        await provider.user(token);
        throw new Error('Expected fixture failure.');
      } catch (error) {
        expect(error).toMatchObject({ code: scenario.expected });
        expect(String(error)).not.toContain(token);
        expect(String(error)).not.toContain('private upstream');
      }
    }
    transport.mockImplementationOnce(async () =>
      json({ error: 'bad_refresh_token', error_description: `private ${token}` }),
    );
    await expect(provider.refresh('fixture-refresh')).rejects.toMatchObject({
      code: 'GITHUB_AUTH_EXPIRED',
    });
    transport.mockImplementationOnce(async () =>
      json({ error: 'incorrect_client_credentials', error_description: config.clientSecret }),
    );
    await expect(provider.exchange('fixture-code', verifier)).rejects.toMatchObject({
      code: 'GITHUB_REMOTE_UNAVAILABLE',
    });
    transport.mockImplementationOnce(async () =>
      json({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0' }),
    );
    await expect(provider.user(token)).rejects.toMatchObject({
      code: 'GITHUB_REMOTE_UNAVAILABLE',
      retryable: true,
    });
    transport.mockImplementationOnce(async () => {
      throw new Error(`transport exception ${token}`);
    });
    await expect(provider.user(token)).rejects.toThrow('GitHub could not complete');
  });

  it('bounds token/API response bodies before parsing and rejects malformed JSON', async () => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response('{invalid-json', { status: 200 }),
    );
    const provider = new GitHubOAuthProvider(config, transport);
    await expect(provider.user(token)).rejects.toMatchObject({ code: 'GITHUB_REMOTE_UNAVAILABLE' });
    transport.mockImplementationOnce(async () => new Response('x'.repeat(65_537), { status: 200 }));
    await expect(provider.exchange('fixture-code', verifier)).rejects.toMatchObject({
      code: 'GITHUB_REMOTE_UNAVAILABLE',
    });
    transport.mockImplementationOnce(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
        }),
    );
    await expect(provider.user(token)).rejects.toMatchObject({ code: 'GITHUB_REMOTE_UNAVAILABLE' });
  });
});
