import Link from 'next/link';
import { stripVTControlCharacters } from 'node:util';
import { Compile } from 'typebox/compile';
import {
  IdSchema,
  RepositoryListSchema,
  RepositoryResponseSchema,
  SessionDirectoryPageSchema,
  SessionDirectoryRequestSchema,
  normalizeSessionDirectoryQuery,
  sessionDirectoryPageMatchesRequest,
  type Repository,
  type SessionDirectoryRequest,
} from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { EmptyState, ErrorState, PageHeading } from '@/components/ui';
import { Icon } from '@/components/icon';
import { SessionRow } from '@/components/evidence';
import { RefreshButton } from '@/components/controls';
import styles from './directory.module.css';

export const dynamic = 'force-dynamic';

type Filters = { query: string; repositoryId: string; status: 'all' | 'open' | 'closed' };
type Parameters = Record<string, string | string[] | undefined>;

function directoryHref(filters: Filters, limit: number, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (filters.query) query.set('query', filters.query);
  if (filters.repositoryId) query.set('repositoryId', filters.repositoryId);
  if (filters.status !== 'all') query.set('status', filters.status);
  if (cursor !== undefined) query.set('cursor', cursor);
  return `/sessions?${query}`;
}

function parseParameters(parameters: Parameters) {
  const errors: string[] = [];
  if (
    Object.keys(parameters).some(
      (key) => !['query', 'repositoryId', 'status', 'limit', 'cursor'].includes(key),
    )
  )
    errors.push('unsupported query parameters');
  const filters: Filters = { query: '', repositoryId: '', status: 'all' };
  if (parameters.query !== undefined) {
    if (typeof parameters.query === 'string' && parameters.query.length <= 200) {
      const normalized = normalizeSessionDirectoryQuery(stripVTControlCharacters(parameters.query));
      if (normalized.length <= 200) filters.query = normalized;
      else errors.push('title query');
    } else errors.push('title query');
  }
  if (parameters.repositoryId !== undefined) {
    if (
      typeof parameters.repositoryId === 'string' &&
      (parameters.repositoryId === '' || Compile(IdSchema).Check(parameters.repositoryId))
    )
      filters.repositoryId = parameters.repositoryId;
    else errors.push('repository filter');
  }
  if (parameters.status !== undefined) {
    if (parameters.status === '' || parameters.status === 'all') filters.status = 'all';
    else if (parameters.status === 'open' || parameters.status === 'closed')
      filters.status = parameters.status;
    else errors.push('status filter');
  }
  let limit = 20;
  if (parameters.limit !== undefined) {
    if (
      typeof parameters.limit === 'string' &&
      /^\d{1,2}$/u.test(parameters.limit) &&
      Number(parameters.limit) >= 1 &&
      Number(parameters.limit) <= 50
    )
      limit = Number(parameters.limit);
    else errors.push('page size');
  }
  let cursor: string | undefined;
  if (parameters.cursor !== undefined) {
    if (
      typeof parameters.cursor === 'string' &&
      parameters.cursor.length >= 1 &&
      parameters.cursor.length <= 2048
    )
      cursor = parameters.cursor;
    else errors.push('page cursor');
  }
  const input: SessionDirectoryRequest = {
    limit,
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.repositoryId ? { repositoryId: filters.repositoryId } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
  if (!Compile(SessionDirectoryRequestSchema).Check(input) && errors.length === 0)
    errors.push('directory filters');
  return { filters, limit, cursor, input, errors };
}

function FilterForm({
  filters,
  limit,
  repositories,
}: {
  filters: Filters;
  limit: number;
  repositories: Repository[];
}) {
  const pageSizes = [...new Set([10, 20, 50, limit])].sort((left, right) => left - right);
  const selectedIsMissing =
    filters.repositoryId &&
    !repositories.some((repository) => repository.id === filters.repositoryId);
  return (
    <section className={`panel ${styles.filters}`} aria-label="Investigation filters">
      <form
        key={JSON.stringify({ filters, limit })}
        method="get"
        action="/sessions"
        className={styles.form}
      >
        <label className={`${styles.field} ${styles.search}`}>
          <span>Search investigation titles</span>
          <input
            className="input"
            type="search"
            name="query"
            defaultValue={filters.query}
            placeholder="Title text…"
            maxLength={200}
          />
        </label>
        <label className={`${styles.field} ${styles.repository}`}>
          <span>Repository</span>
          <select className="select" name="repositoryId" defaultValue={filters.repositoryId}>
            <option value="">All repositories</option>
            {selectedIsMissing && (
              <option value={filters.repositoryId}>
                Selected repository unavailable · {filters.repositoryId}
              </option>
            )}
            {repositories.map((repository) => (
              <option value={repository.id} key={repository.id}>
                {repository.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Status</span>
          <select className="select" name="status" defaultValue={filters.status}>
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>Per page</span>
          <select className="select" name="limit" defaultValue={limit}>
            {pageSizes.map((size) => (
              <option value={size} key={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.formActions}>
          <button className="button button-small" type="submit">
            <Icon name="search" size={13} />
            Apply filters
          </button>
        </div>
      </form>
      <div className={styles.filterHelp}>
        <p>
          Search matches investigation titles only. Applying filters starts at the newest matching
          results.
        </p>
        <Link
          className="inline-link"
          href={
            filters.repositoryId
              ? `/ask?repositoryId=${encodeURIComponent(filters.repositoryId)}`
              : '/ask'
          }
        >
          Search errors and content with Ask <Icon name="arrow" size={11} />
        </Link>
      </div>
    </section>
  );
}

function Pagination({
  filters,
  limit,
  nextCursor,
  hasCursor,
  position,
}: {
  filters: Filters;
  limit: number;
  nextCursor: string | null;
  hasCursor: boolean;
  position: 'top' | 'bottom';
}) {
  return (
    <nav className={styles.pagination} aria-label={`Investigation directory pages, ${position}`}>
      {hasCursor ? (
        <Link
          className="button button-small button-ghost"
          href={directoryHref(filters, limit)}
          prefetch={false}
        >
          <Icon name="arrow" size={12} style={{ transform: 'rotate(180deg)' }} />
          First page
        </Link>
      ) : (
        <span className="button button-small button-ghost button-disabled" aria-disabled="true">
          Newest results
        </span>
      )}
      <span className={styles.pageCaption}>Newest creation first · up to {limit} per page</span>
      {nextCursor ? (
        <Link
          className="button button-small button-ghost"
          href={directoryHref(filters, limit, nextCursor)}
          prefetch={false}
        >
          Older results <Icon name="arrow" size={12} />
        </Link>
      ) : (
        <span className="button button-small button-ghost button-disabled" aria-disabled="true">
          No older results
        </span>
      )}
    </nav>
  );
}

export default async function Investigations({
  searchParams,
}: {
  searchParams: Promise<Parameters>;
}) {
  const { filters, limit, cursor, input, errors } = parseParameters(await searchParams);
  const heading = (
    <PageHeading
      eyebrow="RECORDED WORK"
      title="Investigations"
      description="Find an investigation by title, repository, or current status, then follow its recorded evidence."
      action={<RefreshButton />}
    />
  );
  const firstHref = directoryHref(filters, limit);
  if (errors.length > 0)
    return (
      <>
        {heading}
        <ErrorState
          message={`This directory link has invalid values: ${errors.join(', ')}.`}
          detail="Each filter must have one valid value. Use a title up to 200 characters and a page size from 1 to 50."
        />
        <div className={styles.recovery}>
          <Link className="button button-small" href={firstHref} prefetch={false}>
            Keep valid filters and restart <Icon name="arrow" size={12} />
          </Link>
          <Link className="inline-link" href="/sessions">
            Reset all filters
          </Link>
        </div>
      </>
    );

  const repositories = await apiRequest('/v1/repositories', RepositoryListSchema);
  if (!repositories.ok)
    return (
      <>
        {heading}
        <ErrorState message="Repository filters are unavailable." detail={repositories.message} />
        <p className={styles.caption}>
          The requested view has not been replaced with an all-repository search. Refresh to retry
          the same filters.
        </p>
        <Link className="inline-link" href={firstHref} prefetch={false}>
          Restart at the first page with these filters <Icon name="arrow" size={12} />
        </Link>
      </>
    );
  const repos = [...repositories.data.items];
  if (filters.repositoryId && !repos.some((repository) => repository.id === filters.repositoryId)) {
    const selected = await apiRequest(
      `/v1/repositories/${encodeURIComponent(filters.repositoryId)}`,
      RepositoryResponseSchema,
    );
    if (!selected.ok)
      return (
        <>
          {heading}
          <FilterForm filters={filters} limit={limit} repositories={repos} />
          <ErrorState message="The selected repository is unavailable." detail={selected.message} />
          <p className={styles.caption}>
            The repository filter is retained. Choose another repository or explicitly select All
            repositories to change the scope.
          </p>
        </>
      );
    repos.push(selected.data.repository);
  }
  const sessions = await apiRequest('/v1/sessions/search', SessionDirectoryPageSchema, {
    method: 'POST',
    body: input,
  });
  if (!sessions.ok)
    return (
      <>
        {heading}
        <FilterForm filters={filters} limit={limit} repositories={repos} />
        <ErrorState
          message={sessions.message}
          detail={
            sessions.status === 400
              ? 'The page cursor or filters are no longer valid together. Start from the first page with the same valid filters.'
              : 'The investigation directory could not be read. Refresh to retry this view.'
          }
        />
        <div className={styles.recovery}>
          <Link className="button button-small" href={firstHref} prefetch={false}>
            First page with these filters <Icon name="arrow" size={12} />
          </Link>
          <Link className="inline-link" href="/sessions">
            Reset all filters
          </Link>
        </div>
      </>
    );
  if (!sessionDirectoryPageMatchesRequest(sessions.data, input))
    return (
      <>
        {heading}
        <FilterForm filters={filters} limit={limit} repositories={repos} />
        <ErrorState
          message="The directory response did not match the requested filters."
          detail="Refresh or reopen the first page with these filters."
        />
        <div className={styles.recovery}>
          <Link className="button button-small" href={firstHref} prefetch={false}>
            First page with these filters <Icon name="arrow" size={12} />
          </Link>
        </div>
      </>
    );
  const { items, page } = sessions.data;
  const activeFilters: Filters = {
    ...sessions.data.filters,
    repositoryId: sessions.data.filters.repositoryId ?? '',
  };
  const repoMap = new Map(repos.map((repository) => [repository.id, repository]));
  const hasFilters =
    !!activeFilters.query || !!activeFilters.repositoryId || activeFilters.status !== 'all';
  return (
    <>
      {heading}
      <FilterForm filters={activeFilters} limit={page.limit} repositories={repos} />
      <div className={styles.resultsHeading}>
        <p>
          Showing <strong>{page.returnedItems}</strong> of <strong>{page.totalMatching}</strong>{' '}
          matching investigation{page.totalMatching === 1 ? '' : 's'}.
        </p>
        {(hasFilters || cursor !== undefined || page.limit !== 20) && (
          <Link href="/sessions" className="inline-link">
            Reset all filters <Icon name="close" size={11} />
          </Link>
        )}
      </div>
      <p className={styles.liveNotice}>
        Results are live, ordered by investigation creation time, newest first. New investigations,
        status changes, and deletions can change matches between page requests. These pages are not
        a fixed snapshot.
      </p>
      {items.some((session) => session.titleTruncated) && (
        <p className={styles.caption}>
          Some displayed titles are shortened. Open an investigation to read its full title.
        </p>
      )}
      <section className={`panel ${styles.results}`} aria-label="Matching investigations">
        <Pagination
          filters={activeFilters}
          limit={page.limit}
          nextCursor={page.nextCursor}
          hasCursor={cursor !== undefined}
          position="top"
        />
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
              cursor !== undefined
                ? 'No investigations remain on this older page.'
                : hasFilters
                  ? 'No investigations match these filters.'
                  : 'No investigations recorded yet.'
            }
            description={
              cursor !== undefined
                ? 'Matching records may have changed or been deleted. Return to the first page to see current results.'
                : hasFilters
                  ? 'Try another title, repository, or status. Use Ask to search the contents of recorded evidence.'
                  : 'Start an investigation with the CLI and capture a real command. Its original evidence will appear here.'
            }
            action={
              cursor !== undefined ? (
                <Link
                  href={directoryHref(activeFilters, page.limit)}
                  className="button button-small"
                  prefetch={false}
                >
                  Open first page <Icon name="arrow" size={12} />
                </Link>
              ) : hasFilters ? (
                <Link href="/sessions" className="button button-small">
                  Reset filters <Icon name="arrow" size={12} />
                </Link>
              ) : (
                <Link href="/repositories" className="button button-small">
                  View repositories <Icon name="arrow" size={12} />
                </Link>
              )
            }
          />
        )}
        {items.length > 0 && (
          <Pagination
            filters={activeFilters}
            limit={page.limit}
            nextCursor={page.nextCursor}
            hasCursor={cursor !== undefined}
            position="bottom"
          />
        )}
      </section>
    </>
  );
}
