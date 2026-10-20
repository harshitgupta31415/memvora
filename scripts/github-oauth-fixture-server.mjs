// Explicit acceptance-only server. It never connects to GitHub or opens the user's database.
import { buildApp } from '../apps/api/dist/app.js';
import { registerGitHubRoutes } from '../apps/api/dist/integrations/github.js';
import { GitHubOAuthProvider } from '../apps/api/dist/integrations/github-oauth-provider.js';
import { GitHubConnections } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';

if (process.env.MEMVORA_OAUTH_TEST_MODE !== 'fixture-only' || !process.send)
  throw new Error('This entry point is reserved for the isolated OAuth acceptance check.');
const secret = process.env.MEMVORA_LOCAL_TOKEN;
const callbackUrl = process.env.MEMVORA_OAUTH_TEST_CALLBACK;
if (!secret || secret.length < 32 || !callbackUrl)
  throw new Error('Acceptance configuration is missing.');
const config = {
  appId: 111,
  clientId: 'Iv1.memvora-fixture',
  clientSecret: 'fixture-client-secret',
  callbackUrl,
};
const repository = {
  id: 12,
  full_name: 'fixture-owner/oauth-acceptance',
  name: 'oauth-acceptance',
  private: true,
  description: 'Labeled in-memory acceptance fixture',
  default_branch: 'main',
  html_url: 'https://github.com/fixture-owner/oauth-acceptance',
  permissions: { pull: true },
};
const json = (value) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const provider = new GitHubOAuthProvider(config, async (input) => {
  const url = new URL(String(input));
  if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token')
    return json({
      access_token: 'acceptance-access-fixture',
      refresh_token: 'acceptance-refresh-fixture',
      expires_in: 3600,
      refresh_token_expires_in: 86400,
      token_type: 'bearer',
      scope: '',
    });
  if (url.origin !== 'https://api.github.com') throw new Error('Fixture origin is not allowed.');
  if (url.pathname === '/user')
    return json({
      id: 123,
      login: 'fixture-owner',
      avatar_url: 'https://avatars.githubusercontent.com/u/123',
    });
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
  if (url.pathname === '/repos/fixture-owner/oauth-acceptance') return json(repository);
  if (url.pathname.endsWith('/commits/main'))
    return json({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } });
  if (url.pathname.includes('/git/trees/'))
    return json({
      tree: [{ type: 'blob', mode: '100644', path: 'fixture.ts', size: 44, sha: 'c'.repeat(40) }],
      truncated: false,
    });
  if (url.pathname.includes('/git/blobs/'))
    return json({
      encoding: 'base64',
      content: Buffer.from('export const isolatedOAuthAcceptance = true;').toString('base64'),
    });
  if (url.pathname.endsWith('/issues')) return json([]);
  throw new Error('Unexpected acceptance-only resource.');
});
const store = new SqliteEvidenceStore(':memory:');
const oauth = new GitHubConnections(store, config, provider, secret);
const app = buildApp({
  store,
  token: secret,
  embeddedWorker: false,
  registerIntegrations: (instance, service) =>
    registerGitHubRoutes(instance, service, {
      requested: true,
      callbackUrl,
      message: 'Labeled isolated test provider; no live GitHub authorization.',
      connection: oauth,
    }),
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close().finally(() => process.exit());
  });
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
process.send({ ready: true, origin, fixture: true });
