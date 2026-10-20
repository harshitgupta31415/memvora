'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  GitHubImportResponseSchema,
  GitHubInstallationListSchema,
  GitHubRepositoryListSchema,
  type GitHubInstallation,
  type GitHubRepository,
  type GitHubStatus,
} from '@memvora/contracts';
import { getJson, submitJson } from '@/lib/client-api';
import { Icon } from './icon';

export function GitHubBrowser({ status }: { status: GitHubStatus }) {
  // A different account or connection must never reuse an earlier browser list.
  const identity = `${status.mode}:${status.user?.id ?? status.oauth.user?.id ?? 'none'}:${status.available}:${status.oauth.connected}:${status.oauth.expiresAt ?? ''}`;
  return <GitHubAccessBrowser key={identity} status={status} />;
}

function GitHubAccessBrowser({ status }: { status: GitHubStatus }) {
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [installationPage, setInstallationPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  async function loadInstallations(next = 1) {
    setLoading(true);
    setError('');
    if (next === 1) setSelected('');
    try {
      const result = await getJson(
        `/api/github/installations?page=${next}`,
        GitHubInstallationListSchema,
      );
      setInstallations((current) =>
        next === 1
          ? result.items
          : [
              ...current,
              ...result.items.filter(
                (item) => !current.some((previous) => previous.id === item.id),
              ),
            ],
      );
      setInstallationPage(result.page);
      setHasMore(result.hasMore);
      setLoaded(true);
    } catch (failure) {
      setInstallations([]);
      setLoaded(false);
      setSelected('');
      setHasMore(false);
      setError(
        failure instanceof Error
          ? failure.message
          : 'Authorized installations could not be listed.',
      );
    } finally {
      setLoading(false);
    }
  }
  const installation = installations.find((item) => String(item.id) === selected);
  return (
    <section className="panel section-padding section-top">
      <div className="section-heading">
        <div>
          <h2>Bring in repository context</h2>
          <p>
            {status.mode === 'github_app'
              ? 'Select an authorized App installation, then choose a repository for a bounded import.'
              : status.mode === 'gh_cli'
                ? 'Use the local GitHub CLI authorization to explicitly choose a repository.'
                : 'Set up GitHub access before choosing a repository to import.'}
          </p>
        </div>
        {status.available && status.mode === 'github_app' && (
          <button
            className="button button-small"
            type="button"
            disabled={loading}
            onClick={() => {
              void loadInstallations();
            }}
          >
            <Icon name="repo" size={14} />
            {loading ? 'Loading…' : loaded ? 'Refresh installations' : 'Browse installations'}
          </button>
        )}
      </div>
      <p className="muted-caption">
        {status.message} Imports store a bounded snapshot. Connecting or listing a repository does
        not import it automatically.
      </p>
      {!status.available && (
        <p className="settings-help">
          Review the GitHub connection above before browsing repositories.
        </p>
      )}
      {error && (
        <p className="form-error section-top" role="alert">
          {error}
        </p>
      )}
      {status.available && status.mode === 'github_app' && loaded && (
        <div className="github-installation-picker section-top">
          <label>
            <span>Authorized installation</span>
            <select
              className="select"
              value={selected}
              disabled={loading}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Choose an installation</option>
              {installations.map((item) => (
                <option key={item.id} value={item.id} disabled={item.suspended}>
                  {item.accountLogin} ·{' '}
                  {item.repositorySelection === 'selected'
                    ? 'selected repositories'
                    : 'all repositories'}
                  {item.suspended ? ' · suspended' : ''}
                </option>
              ))}
            </select>
          </label>
          {hasMore && (
            <button
              type="button"
              className="button button-small button-ghost"
              disabled={loading}
              onClick={() => {
                void loadInstallations(installationPage + 1);
              }}
            >
              {loading ? 'Loading…' : 'Load more installations'}
            </button>
          )}
          {!installations.length && (
            <p className="settings-help">
              No authorized installation was returned on this page. Install the configured private
              GitHub App for the required account and repositories using the setup instructions,
              then refresh installations.
            </p>
          )}
        </div>
      )}
      {status.available && status.mode === 'gh_cli' && <RepositoryPicker mode="gh_cli" />}
      {status.available &&
        status.mode === 'github_app' &&
        installation &&
        !installation.suspended && (
          <div className="section-top">
            <p className="muted-caption">
              Installation {installation.id} · {installation.accountLogin} ·{' '}
              {installation.repositorySelection === 'selected'
                ? 'Only repositories selected in GitHub'
                : 'Repositories authorized for this installation'}
            </p>
            <RepositoryPicker
              key={installation.id}
              mode="github_app"
              installationId={installation.id}
            />
          </div>
        )}
    </section>
  );
}

function RepositoryPicker({
  mode,
  installationId,
}: {
  mode: 'gh_cli' | 'github_app';
  installationId?: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState<GitHubRepository[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [imported, setImported] = useState<{
    id: string;
    name: string;
    files: number;
    partial: boolean;
  } | null>(null);
  async function load(next = 1) {
    setLoading(true);
    setError('');
    setImported(null);
    try {
      const query = new URLSearchParams({ page: String(next) });
      if (installationId !== undefined) query.set('installationId', String(installationId));
      const result = await getJson(`/api/github/repositories?${query}`, GitHubRepositoryListSchema);
      setItems((current) =>
        next === 1
          ? result.items
          : [
              ...current,
              ...result.items.filter((repo) => !current.some((item) => item.id === repo.id)),
            ],
      );
      setPage(result.page);
      setHasMore(result.hasMore);
      setLoaded(true);
    } catch (failure) {
      setItems([]);
      setLoaded(false);
      setHasMore(false);
      setError(
        failure instanceof Error ? failure.message : 'GitHub repositories could not be listed.',
      );
    } finally {
      setLoading(false);
    }
  }
  async function importRepo(repo: GitHubRepository) {
    setPending(repo.fullName);
    setError('');
    setImported(null);
    try {
      if (
        mode === 'github_app' &&
        (installationId === undefined ||
          repo.installationId !== installationId ||
          repo.accessPage === undefined)
      )
        throw new Error(
          'Repository access details are missing. Refresh the authorized repository list.',
        );
      const input =
        mode === 'github_app'
          ? {
              fullName: repo.fullName,
              installationId,
              repositoryId: repo.id,
              repositoryPage: repo.accessPage,
            }
          : { fullName: repo.fullName };
      const result = await submitJson(
        '/api/github/import',
        input,
        GitHubImportResponseSchema,
        65_000,
      );
      setImported({
        id: result.repository.id,
        name: result.repository.name,
        files: result.context.files.length,
        partial: result.partial,
      });
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The import could not be completed.');
    } finally {
      setPending('');
    }
  }
  return (
    <div className="github-repository-picker">
      <button
        type="button"
        className="button button-small section-top"
        onClick={() => {
          void load();
        }}
        disabled={loading || !!pending}
      >
        <Icon name="repo" size={14} />
        {loading ? 'Loading…' : loaded ? 'Refresh repository list' : 'Browse repositories'}
      </button>
      {error && (
        <p className="form-error section-top" role="alert">
          {error}
        </p>
      )}
      {imported && (
        <div className="notice section-top" role="status">
          <Icon name="check" size={18} />
          <div>
            <strong>
              {imported.name} imported with {imported.files} retained file
              {imported.files === 1 ? '' : 's'}.
            </strong>
            <p>
              {imported.partial
                ? 'This bounded import is partial. Inspect the retained files before assuming more code is available.'
                : 'A bounded repository snapshot is stored locally with its source commit.'}
            </p>
            <Link className="inline-link" href={`/repositories/${imported.id}`}>
              Inspect imported context <Icon name="arrow" size={12} />
            </Link>
          </div>
        </div>
      )}
      {loaded && (
        <div className="github-list">
          {items.length ? (
            items.map((repo) => (
              <div className="github-repo-row" key={repo.id}>
                <span className="session-symbol">
                  <Icon name="repo" size={15} />
                </span>
                <div className="github-repo-copy">
                  <h3>
                    {repo.fullName}
                    <span className="github-visibility">{repo.private ? 'Private' : 'Public'}</span>
                  </h3>
                  <p>{repo.description ?? `Default branch: ${repo.defaultBranch}`}</p>
                </div>
                <button
                  type="button"
                  className="button button-small"
                  disabled={!!pending || loading}
                  onClick={() => {
                    void importRepo(repo);
                  }}
                >
                  {pending === repo.fullName ? 'Importing…' : 'Import'}
                  <Icon name={pending === repo.fullName ? 'clock' : 'plus'} size={12} />
                </button>
              </div>
            ))
          ) : (
            <p className="settings-help section-top">
              No repositories were returned for this authorized selection.
            </p>
          )}
          {hasMore && (
            <button
              type="button"
              className="button button-small section-top"
              disabled={loading || !!pending}
              onClick={() => {
                void load(page + 1);
              }}
            >
              {loading ? 'Loading…' : 'Load more repositories'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
