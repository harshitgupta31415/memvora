import Link from 'next/link';
import { Compile } from 'typebox/compile';
import { JobListSchema, JobsQuerySchema, RepositoryListSchema } from '@memvora/contracts';
import type { JobsQuery } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { DateLabel, EmptyState, ErrorState, PageHeading, StatusBadge } from '@/components/ui';
import { RefreshButton } from '@/components/controls';
import { RetryJobButton } from '@/components/job-controls';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

export default async function ProcessingJobs({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const candidate = {
    limit: 100,
    ...Object.fromEntries(
      ['repositoryId', 'sessionId', 'status']
        .filter((key) => parameters[key] !== undefined && parameters[key] !== '')
        .map((key) => [key, parameters[key]]),
    ),
  };
  if (!Compile(JobsQuerySchema).Check(candidate))
    return (
      <>
        <PageHeading
          title="Memory processing"
          description="Follow summary processing while original command evidence stays available."
        />
        <ErrorState
          message="This processing filter is invalid."
          detail="Choose a single valid repository, investigation, or processing state. No wider scope was loaded."
        />
        <Link href="/jobs" className="inline-link section-top">
          Clear filters <Icon name="arrow" size={12} />
        </Link>
      </>
    );
  const filters = candidate as JobsQuery;
  const query = new URLSearchParams({ limit: '100' });
  if (filters.repositoryId) query.set('repositoryId', filters.repositoryId);
  if (filters.sessionId) query.set('sessionId', filters.sessionId);
  if (filters.status) query.set('status', filters.status);
  const [jobs, repositories] = await Promise.all([
    apiRequest(`/v1/jobs?${query}`, JobListSchema),
    apiRequest('/v1/repositories', RepositoryListSchema),
  ]);
  const repos = repositories.ok ? repositories.data.items : [];
  const repoMap = new Map(repos.map((repo) => [repo.id, repo.name]));
  return (
    <>
      <PageHeading
        eyebrow="EVIDENCE TO MEMORY"
        title="Memory processing"
        description="See what is queued, running, ready, or needs another attempt. Original commands remain available in every state."
        action={<RefreshButton />}
      />
      <div className="toolbar">
        <form
          key={`${filters.repositoryId ?? ''}:${filters.sessionId ?? ''}:${filters.status ?? ''}`}
          method="get"
          className="filter-form"
        >
          {filters.sessionId && <input type="hidden" name="sessionId" value={filters.sessionId} />}
          <select
            className="select"
            name="status"
            aria-label="Processing state"
            defaultValue={filters.status ?? ''}
          >
            <option value="">Every state</option>
            <option value="failed">Needs attention</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="ready">Ready</option>
          </select>
          <select
            className="select"
            name="repositoryId"
            aria-label="Repository scope"
            defaultValue={filters.repositoryId ?? ''}
          >
            <option value="">All repositories</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
          <button type="submit" className="button button-small">
            Filter
          </button>
          {(filters.status || filters.repositoryId || filters.sessionId) && (
            <Link href="/jobs" className="inline-link">
              Clear
            </Link>
          )}
        </form>
        {filters.sessionId && (
          <Link href={`/sessions/${filters.sessionId}`} className="inline-link">
            Back to investigation <Icon name="arrow" size={12} />
          </Link>
        )}
      </div>
      <div className="notice notice-neutral">
        <Icon name="link" size={17} />
        <div>
          <strong>Retry the summary, keep the evidence.</strong>
          <p>
            Each cycle allows up to three automatic attempts. After fixing the connection or
            provider configuration, retry a failed job to start another cycle. It uses the current
            summary configuration and the same stored event. A configured AI provider may receive
            that evidence again.
          </p>
        </div>
      </div>
      {!jobs.ok ? (
        <ErrorState message={jobs.message} />
      ) : (
        <section className="panel section-padding">
          {jobs.data.items.length ? (
            <>
              <p className="muted-caption">
                Showing up to 100 most recent jobs in this view. Refresh to see processing changes.
              </p>
              <ol className="job-list">
                {jobs.data.items.map((job) => (
                  <li key={job.id} className="job-row">
                    <div className="job-content">
                      <div className="job-heading">
                        <StatusBadge status={job.status} />
                        <Link href={`/events/${job.eventId}`} className="inline-link">
                          Original command <Icon name="arrow" size={11} />
                        </Link>
                        {job.status === 'ready' && (
                          <Link href={`/memories/${job.eventId}`} className="inline-link">
                            View memory <Icon name="arrow" size={11} />
                          </Link>
                        )}
                      </div>
                      <p className="job-repository">
                        {repoMap.get(job.repositoryId) ?? 'Scoped repository'}
                      </p>
                      <div className="job-meta">
                        <span>
                          Attempts {job.attempts}/{job.maxAttempts} this cycle
                        </span>
                        <span>
                          {job.retryCount} manual retr{job.retryCount === 1 ? 'y' : 'ies'}
                        </span>
                        <span>
                          Recorded <DateLabel value={job.createdAt} relative />
                        </span>
                      </div>
                      {job.status === 'queued' && job.lastError && (
                        <p className="muted-caption">
                          Automatic retry eligible after <DateLabel value={job.availableAt} />.
                        </p>
                      )}
                      {job.status === 'running' && job.leaseUntil && (
                        <p className="muted-caption">
                          Worker lease until <DateLabel value={job.leaseUntil} />.
                        </p>
                      )}
                      {job.lastError && (
                        <p className="form-error job-error">
                          {job.lastError === 'LEASE_ATTEMPTS_EXHAUSTED'
                            ? 'The worker lease expired after the attempt limit.'
                            : 'Enrichment failed. Check the provider configuration and worker connection.'}
                        </p>
                      )}
                    </div>
                    {job.canRetry && (
                      <RetryJobButton key={`${job.id}:${job.retryCount}`} id={job.id} />
                    )}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <EmptyState
              icon="clock"
              title="No processing jobs in this view."
              description="New command evidence creates a summary job after it is accepted. Adjust the filters or capture another command."
            />
          )}
        </section>
      )}
    </>
  );
}
