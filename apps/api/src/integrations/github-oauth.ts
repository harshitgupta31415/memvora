import { GitHubConnections, type GitHubAppConfig, type LocalEvidenceStore } from '@memvora/core';
import { GitHubOAuthProvider } from './github-oauth-provider.js';

export type GitHubOAuthSetup = {
  requested: boolean;
  callbackUrl: string;
  message: string;
  connection?: GitHubConnections;
};
export function configuredGitHubOAuth(store: LocalEvidenceStore, secret: string): GitHubOAuthSetup {
  const callbackUrl =
    process.env['GITHUB_CALLBACK_URL'] ?? 'http://127.0.0.1:3000/api/github/oauth/callback';
  const names = [
    'GITHUB_APP_ID',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_CALLBACK_URL',
  ];
  const requested = names.some((name) => Boolean(process.env[name]));
  const unconfigured = {
    requested,
    callbackUrl: 'http://127.0.0.1:3000/api/github/oauth/callback',
    message: requested
      ? 'GitHub App configuration is incomplete or invalid. Review the local setup guide.'
      : 'Register and configure a private GitHub App to enable browser authorization.',
  };
  if (!requested) return unconfigured;
  const appId = Number(process.env['GITHUB_APP_ID']);
  const clientId = process.env['GITHUB_CLIENT_ID'] ?? '';
  const clientSecret = process.env['GITHUB_CLIENT_SECRET'] ?? '';
  try {
    const callback = new URL(callbackUrl);
    if (
      !Number.isSafeInteger(appId) ||
      appId < 1 ||
      !/^[A-Za-z0-9_.-]{1,200}$/.test(clientId) ||
      clientSecret.length < 8 ||
      clientSecret.length > 4096 ||
      /\s/.test(clientSecret) ||
      callback.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      callback.pathname !== '/api/github/oauth/callback'
    )
      return unconfigured;
    const config: GitHubAppConfig = { appId, clientId, clientSecret, callbackUrl: callback.href };
    return {
      requested: true,
      callbackUrl: config.callbackUrl,
      message: 'Private GitHub App browser authorization is configured.',
      connection: new GitHubConnections(store, config, new GitHubOAuthProvider(config), secret),
    };
  } catch {
    return unconfigured;
  }
}
