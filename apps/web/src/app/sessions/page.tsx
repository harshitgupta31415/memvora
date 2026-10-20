import Link from 'next/link';
import { RepositoryListSchema, SessionListSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { EmptyState, ErrorState, PageHeading } from '@/components/ui';
import { Icon } from '@/components/icon';
import { SessionRow } from '@/components/evidence';
import { RefreshButton } from '@/components/controls';

export const dynamic = 'force-dynamic';

export default async function Investigations({
  searchParams,
}: {
  searchParams: Promise<{ repositoryId?: string | string[]; query?: string | string[] }>;
}) {
  const parameters = await searchParams;
  const filter = {
    repositoryId:
      typeof parameters.repositoryId === 'string' ? parameters.repositoryId.slice(0, 100) : '',
    query: typeof parameters.query === 'string' ? parameters.query.slice(0, 200) : '',
  };
  const [sessions, repositories] = await Promise.all([
    apiRequest('/v1/sessions', SessionListSchema),
    apiRequest('/v1/repositories', RepositoryListSchema),
  ]);
  const repos = repositories.ok ? repositories.data.items : [];
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]));
  const items = sessions.ok
    ? sessions.data.items.filter(
        (session) =>
          (!filter.repositoryId || session.repositoryId === filter.repositoryId) &&
          (!filter.query || session.title.toLowerCase().includes(filter.query.toLowerCase())),
      )
    : [];
  return (
    <>
      <PageHeading
        eyebrow="RECORDED WORK"
        title="Investigations"
        description="Follow the attempts, errors, changes, and checks in the order they happened."
        action={<RefreshButton />}
      />
      <div className="toolbar">
        <form key={`${filter.repositoryId}:${filter.query}`} method="get" className="filter-form">
          <div className="search-input">
            <Icon name="search" size={15} />
            <input
              className="input"
              aria-label="Search investigation titles"
              type="search"
              name="query"
              defaultValue={filter.query ?? ''}
              placeholder="Search investigations…"
              maxLength={200}
            />
          </div>
          <select
            className="select"
            aria-label="Filter by repository"
            name="repositoryId"
            defaultValue={filter.repositoryId ?? ''}
          >
            <option value="">All repositories</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
          <button className="button button-small" type="submit">
            Filter
          </button>
          {(filter.query || filter.repositoryId) && (
            <Link href="/sessions" className="inline-link">
              Clear
            </Link>
          )}
        </form>
        <span className="list-count">
          {items.length} investigation{items.length === 1 ? '' : 's'}
        </span>
      </div>
      {!sessions.ok ? (
        <ErrorState message={sessions.message} />
      ) : (
        <section className="panel section-padding">
          {items.length ? (
            items.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                {...(repoMap.get(session.repositoryId)
                  ? { repository: repoMap.get(session.repositoryId)! }
                  : {})}
              />
            ))
          ) : (
            <EmptyState
              title={
                filter.query || filter.repositoryId
                  ? 'No investigations match this view.'
                  : 'No investigations recorded yet.'
              }
              description={
                filter.query || filter.repositoryId
                  ? 'Try another title or repository filter.'
                  : 'Start an investigation with the CLI and capture a real command. Its original evidence will appear here.'
              }
              action={
                <Link href="/repositories" className="button button-small">
                  View repositories <Icon name="arrow" size={12} />
                </Link>
              }
            />
          )}
        </section>
      )}
    </>
  );
}
