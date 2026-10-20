'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GitHubDisconnectSchema, type GitHubStatus } from '@memvora/contracts';
import { submitJson } from '@/lib/client-api';
import { Icon } from './icon';
import { CopyCommand } from './controls';
import { DateLabel } from './ui';

export type GitHubConnectionOutcome = 'connected' | 'denied' | 'failed';

export function GitHubConnection({
  status,
  outcome,
}: {
  status: GitHubStatus;
  outcome?: GitHubConnectionOutcome;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [disconnected, setDisconnected] = useState(false);
  const account = status.oauth.user;
  async function disconnect() {
    setPending(true);
    setError('');
    try {
      await submitJson('/api/github/oauth/disconnect', {}, GitHubDisconnectSchema);
      setDisconnected(true);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Local GitHub access could not be disconnected.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="panel section-padding section-top github-connection"
      aria-labelledby="github-connection-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="github-connection-title">GitHub connection</h2>
          <p>
            Choose authorized code context for this local workspace. Connecting GitHub does not
            create a hosted Memvora sign-in.
          </p>
        </div>
        <span className={`connection-state ${status.available ? 'connection-state-ready' : ''}`}>
          {status.mode === 'gh_cli' && status.available
            ? 'Local CLI access'
            : status.oauth.connected
              ? status.available
                ? 'Connected'
                : 'Needs attention'
              : 'Not connected'}
        </span>
      </div>
      {outcome && (
        <div
          className={`notice ${outcome === 'connected' && status.oauth.connected ? '' : 'notice-warning'}`}
          role="status"
        >
          <Icon
            name={outcome === 'connected' && status.oauth.connected ? 'check' : 'alert'}
            size={17}
          />
          <p>
            {outcome === 'connected'
              ? status.oauth.connected
                ? 'Your GitHub account is connected. Choose an installation and repository to import.'
                : 'GitHub authorization returned, but the local connection is not active. Try connecting again.'
              : outcome === 'denied'
                ? 'GitHub authorization was declined. You can connect again when ready.'
                : 'GitHub connection could not be completed. Check the configured callback address and try again.'}
          </p>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {disconnected && !status.oauth.connected && (
        <p className="success-text" role="status">
          Local GitHub access disconnected. Stored evidence has been retained.
        </p>
      )}
      <div className="github-connection-body">
        <div className="github-connection-copy">
          {status.oauth.configured ? (
            <>
              <h3>
                {status.oauth.connected && account
                  ? `Connected account: ${account.login}`
                  : 'Connect your GitHub account'}
              </h3>
              <p>{status.message}</p>
              {account && (
                <p className="muted-caption">
                  GitHub user ID {account.id}
                  {status.oauth.expiresAt && (
                    <>
                      {' '}
                      · Access expires <DateLabel value={status.oauth.expiresAt} />
                    </>
                  )}
                </p>
              )}
              <p className="settings-help">
                Only installations and repositories authorized for the configured GitHub App can be
                browsed. Install or manage the App in GitHub, then explicitly select what to import.
              </p>
              <a
                className="inline-link"
                href="https://github.com/settings/installations"
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage GitHub App installations <Icon name="arrow" size={12} />
              </a>
            </>
          ) : (
            <>
              <h3>Browser connection is not configured</h3>
              <p>{status.oauth.message}</p>
              <p className="settings-help">
                The workspace owner must configure the private GitHub App using{' '}
                <code>docs/GITHUB_SETUP.md</code> and restart the API before browser connection is
                available.
              </p>
              {status.mode === 'gh_cli' && status.available ? (
                <p>
                  Repository browsing currently uses the local GitHub CLI account
                  {status.user ? ` ${status.user.login}` : ''}.
                </p>
              ) : (
                <>
                  <p>{status.message}</p>
                  <p className="settings-help">
                    If using the CLI-only configuration, authenticate on this computer and refresh
                    connection status. Incomplete browser App settings must be corrected using the
                    setup guide.
                  </p>
                  <CopyCommand command="gh auth login" />
                </>
              )}
            </>
          )}
        </div>
        <div className="github-connection-actions">
          {status.oauth.configured && (
            <form method="post" action="/api/github/oauth/start">
              <button className="button button-small" type="submit" disabled={pending}>
                <Icon name="link" size={13} />
                {status.oauth.connected ? 'Reconnect GitHub' : 'Connect GitHub'}
              </button>
            </form>
          )}
          {status.oauth.connected && (
            <button
              className="button button-small button-ghost"
              type="button"
              disabled={pending}
              onClick={() => {
                void disconnect();
              }}
            >
              {pending ? 'Disconnecting…' : 'Disconnect local access'}
            </button>
          )}
        </div>
      </div>
      {status.oauth.connected && (
        <p className="github-disconnect-note">
          Disconnect removes this workspace’s saved GitHub credential. Stored history remains. It
          does not uninstall the App or revoke its GitHub grant; manage those permissions in GitHub
          settings.
        </p>
      )}
      <p className="muted-caption github-callback-address">
        Browser callback address: <span className="mono">{status.oauth.callbackUrl}</span>
      </p>
    </section>
  );
}
