'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Compile } from 'typebox/compile';
import {
  GitHubImportResponseSchema,
  GitHubRepositoryListSchema,
  type GitHubRepository,
  type GitHubStatus,
} from '@memvora/contracts';
import { submitJson } from '@/lib/client-api';
import { Icon } from './icon';
import { CopyCommand } from './controls';

export function GitHubBrowser({ status }: { status: GitHubStatus }) {
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
    try {
      const response = await fetch(`/api/github/repositories?page=${next}`, {
        signal: AbortSignal.timeout(20_000),
      });
      const value: unknown = await response.json();
      if (!response.ok || !Compile(GitHubRepositoryListSchema).Check(value))
        throw new Error(
          'GitHub repositories could not be listed. Check the local GitHub CLI authentication and try again.',
        );
      const result = value as { items: GitHubRepository[]; page: number; hasMore: boolean };
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
      setError(failure instanceof Error ? failure.message : 'GitHub is unavailable.');
    } finally {
      setLoading(false);
    }
  }
  async function importRepo(fullName: string) {
    setPending(fullName);
    setError('');
    setImported(null);
    try {
      const result = await submitJson(
        '/api/github/import',
        { fullName },
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
    <section className="panel section-padding section-top">
      <div className="section-heading">
        <div>
          <h2>Bring in repository context</h2>
          <p>
            {status.available
              ? `Using local GitHub CLI access${status.user ? ` for ${status.user.login}` : ''}. Select the repository you want to import.`
              : 'Connect local GitHub CLI access, then explicitly choose a repository.'}
          </p>
        </div>
        {status.available && (
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              void load();
            }}
            disabled={loading || !!pending}
          >
            <Icon name="repo" size={14} />
            {loading ? 'Loading…' : loaded ? 'Refresh GitHub list' : 'Browse GitHub'}
          </button>
        )}
      </div>
      <p className="muted-caption">
        {status.message} This bridge uses the GitHub CLI's existing authorization; it does not
        install a GitHub App or complete browser OAuth.
      </p>
      {!status.available && <CopyCommand command="gh auth login" />}
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
                ? 'This is a bounded partial import. Inspect the retained files before assuming a full codebase is available.'
                : 'Repository context is stored locally with its source commit.'}
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
                    void importRepo(repo.fullName);
                  }}
                >
                  {pending === repo.fullName ? 'Importing…' : 'Import'}
                  <Icon name={pending === repo.fullName ? 'clock' : 'plus'} size={12} />
                </button>
              </div>
            ))
          ) : (
            <p className="settings-help section-top">
              No repositories were returned for this account.
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
    </section>
  );
}
