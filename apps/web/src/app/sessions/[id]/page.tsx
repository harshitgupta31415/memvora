import Link from 'next/link';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Compile } from 'typebox/compile';
import {
  IdSchema,
  RepositoryResponseSchema,
  SessionEventsPageSchema,
  SessionEventsQuerySchema,
} from '@memvora/contracts';
import type { SessionEventsPage } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import {
  DateLabel,
  EmptyState,
  ErrorState,
  PageHeading,
  SectionHeading,
  StatusBadge,
} from '@/components/ui';
import { MemoryCard } from '@/components/evidence';
import { CopyCommand } from '@/components/controls';
import { InvestigationRecap, InvestigationRecapLoading } from '@/components/investigation-recap';

export const dynamic = 'force-dynamic';

function timelineHref(id: string, limit: number, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return `/sessions/${encodeURIComponent(id)}?${query}`;
}

function TimelinePagination({
  id,
  limit,
  page,
  position,
}: {
  id: string;
  limit: number;
  page: SessionEventsPage['page'];
  position: 'top' | 'bottom';
}) {
  return (
    <nav
      className={`timeline-pagination timeline-pagination-${position}`}
      aria-label={`Investigation pages, ${position}`}
    >
      {page.olderCursor ? (
        <Link
          className="button button-small button-ghost"
          href={timelineHref(id, limit, page.olderCursor)}
          prefetch={false}
        >
          <Icon name="arrow" size={12} style={{ transform: 'rotate(180deg)' }} />
          Earlier attempts
        </Link>
      ) : (
        <span className="button button-small button-ghost button-disabled" aria-disabled="true">
          First attempts
        </span>
      )}
      <span className="timeline-pagination-caption">
        {page.firstSequence !== null && page.lastSequence !== null
          ? `Sequences ${page.firstSequence}–${page.lastSequence}`
          : 'No captured attempts'}
      </span>
      {page.newerCursor ? (
        <Link
          className="button button-small button-ghost"
          href={timelineHref(id, limit, page.newerCursor)}
          prefetch={false}
        >
          Later attempts <Icon name="arrow" size={12} />
        </Link>
      ) : (
        <span className="button button-small button-ghost button-disabled" aria-disabled="true">
          Latest in snapshot
        </span>
      )}
    </nav>
  );
}

function outputPreview(output: Array<{ ordinal: number; text: string }>): string {
  let text = '';
  for (const chunk of [...output].sort((left, right) => left.ordinal - right.ordinal)) {
    text += chunk.text.slice(0, 900 - text.length);
    if (text.length === 900) break;
  }
  return text;
}

function commandPreview(executable: string, args: string[]): string {
  const command = [executable, ...args].join(' ');
  return command.length > 300 ? `${command.slice(0, 300)}…` : command;
}

export default async function Investigation({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!Compile(IdSchema).Check(id)) notFound();
  const parameters = await searchParams;
  const limit =
    parameters.limit === undefined
      ? 20
      : typeof parameters.limit === 'string' && /^\d{1,2}$/u.test(parameters.limit)
        ? Number(parameters.limit)
        : Number.NaN;
  const candidate = {
    limit,
    ...(parameters.cursor === undefined ? {} : { cursor: parameters.cursor }),
  };
  const unsupportedParameter = Object.keys(parameters).some(
    (key) => key !== 'limit' && key !== 'cursor',
  );
  if (unsupportedParameter || !Compile(SessionEventsQuerySchema).Check(candidate))
    return (
      <>
        <Link href="/sessions" className="back-link">
          <Icon name="arrow" size={13} />
          All investigations
        </Link>
        <PageHeading
          title="Investigation timeline"
          description="Choose a valid page of recorded attempts."
        />
        <ErrorState
          message="This timeline link is invalid."
          detail="Choose 1–50 attempts per page, or open the latest attempts to restart browsing."
        />
        <Link className="inline-link section-top" href={timelineHref(id, 20)} prefetch={false}>
          Open latest attempts <Icon name="arrow" size={12} />
        </Link>
      </>
    );
  const query = new URLSearchParams({ limit: String(limit) });
  if (typeof parameters.cursor === 'string') query.set('cursor', parameters.cursor);
  const result = await apiRequest(
    `/v1/sessions/${encodeURIComponent(id)}/events?${query}`,
    SessionEventsPageSchema,
  );
  const latestHref = timelineHref(id, limit);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return (
      <>
        <Link href="/sessions" className="back-link">
          <Icon name="arrow" size={13} />
          All investigations
        </Link>
        <PageHeading
          title="Investigation timeline"
          description="Recover the recorded attempts from this investigation."
        />
        <ErrorState
          message={result.message}
          {...(result.status === 400
            ? { detail: 'Open the latest attempts to restart browsing this investigation.' }
            : {})}
        />
        {result.status === 400 && (
          <Link href={latestHref} className="inline-link section-top" prefetch={false}>
            Open latest attempts <Icon name="arrow" size={12} />
          </Link>
        )}
      </>
    );
  }
  const { session, events, memories, page } = result.data;
  const repository = await apiRequest(
    `/v1/repositories/${encodeURIComponent(session.repositoryId)}`,
    RepositoryResponseSchema,
  );
  if (!repository.ok && (repository.status === 403 || repository.status === 404))
    return (
      <ErrorState
        message={repository.message}
        detail="Return to the investigation list to choose an available project."
      />
    );
  const pageSizes = [...new Set([10, 20, 50, limit])].sort((left, right) => left - right);
  const additionalEvents = Math.max(0, session.eventCount - page.snapshotEventCount);
  return (
    <>
      <Link href="/sessions" className="back-link">
        <Icon name="arrow" size={13} />
        All investigations
      </Link>
      <div className="investigation-page-heading">
        <PageHeading
          eyebrow={repository.ok ? repository.data.repository.name : 'INVESTIGATION'}
          title={session.title}
          description="Original attempts and their recorded outcomes, with the linked memory for this page alongside."
          action={
            // A document navigation also refreshes the latest snapshot when this URL is already open.
            <a href={latestHref} className="button button-small button-ghost">
              <Icon name="refresh" size={13} />
              Refresh latest
            </a>
          }
        />
      </div>
      <div className="detail-meta">
        <StatusBadge status={session.status} />
        <span>
          Started <DateLabel value={session.createdAt} />
        </span>
        <span className="meta-divider">/</span>
        <span>
          {session.eventCount} recorded command{session.eventCount === 1 ? '' : 's'} in the session
        </span>
        <span className="meta-divider">/</span>
        <span>
          {session.memoryCount} linked memor{session.memoryCount === 1 ? 'y' : 'ies'} overall
        </span>
      </div>
      <Suspense fallback={<InvestigationRecapLoading />}>
        <InvestigationRecap sessionId={session.id} />
      </Suspense>
      <section
        className="timeline-snapshot panel section-top"
        aria-labelledby="timeline-snapshot-title"
      >
        <div className="timeline-snapshot-copy">
          <p className="eyebrow">CAPTURED-EVENT SNAPSHOT</p>
          <h2 id="timeline-snapshot-title">
            {page.snapshotEventCount} accepted command{page.snapshotEventCount === 1 ? '' : 's'} in
            this snapshot
          </h2>
          <p>
            Earlier and later pages keep the same captured-event snapshot. Refresh latest or change
            the page size to include newly accepted work. Summary processing can update
            independently.
          </p>
        </div>
        <form
          method="get"
          action={`/sessions/${encodeURIComponent(id)}`}
          className="timeline-page-size"
        >
          <label>
            <span>Attempts per page</span>
            <select className="select" name="limit" defaultValue={limit}>
              {pageSizes.map((size) => (
                <option value={size} key={size}>
                  {size} attempts
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="button button-small">
            Open latest page <Icon name="arrow" size={12} />
          </button>
        </form>
      </section>
      {additionalEvents > 0 && (
        <div className="notice notice-neutral timeline-new-events">
          <Icon name="clock" size={17} />
          <div>
            <strong>
              {additionalEvents} additional command{additionalEvents === 1 ? ' has' : 's have'} been
              accepted since this snapshot opened.
            </strong>
            <p>
              The current session contains {session.eventCount} commands. Continue paging through
              this snapshot, or refresh to include the new arrivals.
            </p>
            <a href={latestHref} className="inline-link">
              Refresh latest <Icon name="arrow" size={12} />
            </a>
          </div>
        </div>
      )}
      <div className="two-column section-top">
        <section className="panel section-padding">
          <SectionHeading
            title="Investigation timeline"
            description="Attempts stay in recorded sequence order, including repeated commands."
          />
          <p className="timeline-range" aria-live="polite" aria-atomic="true">
            {events.length > 0 && page.firstSequence !== null && page.lastSequence !== null ? (
              <>
                Showing {events.length} attempt{events.length === 1 ? '' : 's'}, sequences{' '}
                <strong>
                  {page.firstSequence}–{page.lastSequence}
                </strong>
                .
              </>
            ) : (
              'No captured attempts in this page.'
            )}{' '}
            <span>
              Snapshot: {page.snapshotEventCount}. Current session: {session.eventCount}.
            </span>
          </p>
          <TimelinePagination id={id} limit={limit} page={page} position="top" />
          {events.length ? (
            <ol className="timeline paginated-timeline">
              {[...events]
                .sort((left, right) => left.sequence - right.sequence)
                .map((event) => (
                  <li className="timeline-item" key={event.eventId}>
                    <span className="timeline-point">
                      {String(event.sequence).padStart(2, '0')}
                    </span>
                    <div className="timeline-body">
                      <div className="timeline-top">
                        <Link className="timeline-command mono" href={`/events/${event.eventId}`}>
                          {commandPreview(event.command.executable, event.command.args)}
                        </Link>
                        <StatusBadge
                          status={
                            event.outcome.kind === 'completed' && event.outcome.exitCode !== 0
                              ? 'failed'
                              : event.outcome.kind
                          }
                        />
                      </div>
                      <span className="small text-muted">
                        <DateLabel value={event.startedAt} relative />
                      </span>
                      {event.output.length > 0 && (
                        <pre className="timeline-output" aria-label="Recorded output excerpt">
                          {outputPreview(event.output)}
                        </pre>
                      )}
                      <div className="timeline-footer">
                        <span>Exit {event.outcome.exitCode ?? 'unavailable'}</span>
                        <span>
                          {event.git.commitSha
                            ? event.git.commitSha.slice(0, 8)
                            : 'No recorded commit'}
                        </span>
                        {!event.capture.complete && <span>Incomplete capture</span>}
                        <Link className="inline-link" href={`/events/${event.eventId}`}>
                          Inspect original evidence <Icon name="arrow" size={11} />
                        </Link>
                      </div>
                    </div>
                  </li>
                ))}
            </ol>
          ) : (
            <EmptyState
              title={
                session.eventCount === 0
                  ? 'This investigation is waiting for evidence.'
                  : 'No captured attempts in this snapshot page.'
              }
              description={
                session.eventCount === 0
                  ? 'Run a command through Memvora while this session is active. Output and outcome will be recorded here.'
                  : 'Open the latest attempts to start a new snapshot from the current session.'
              }
              action={
                session.eventCount > 0 ? (
                  <a href={latestHref} className="button button-small">
                    Refresh latest <Icon name="refresh" size={12} />
                  </a>
                ) : undefined
              }
            />
          )}
          {events.length > 0 && (
            <TimelinePagination id={id} limit={limit} page={page} position="bottom" />
          )}
        </section>
        <aside className="content-stack">
          <section className="panel section-padding">
            <SectionHeading
              title="Memory for this page"
              description={`${memories.length} linked summar${memories.length === 1 ? 'y' : 'ies'} for the attempts shown here. Original events remain authoritative.`}
            />
            <p className="muted-caption">
              <Link href={`/jobs?sessionId=${session.id}`} className="inline-link">
                Check investigation processing <Icon name="arrow" size={11} />
              </Link>
            </p>
            {memories.length ? (
              memories.map((memory) => <MemoryCard key={memory.id} memory={memory} />)
            ) : (
              <EmptyState
                icon="link"
                title="No linked memory on this page yet."
                description="Accepted raw commands remain available while their summaries are queued, processing, or awaiting a retry. Check processing for the current state."
              />
            )}
          </section>
          <section className="panel section-padding">
            <SectionHeading title="Continue in the terminal" />
            <CopyCommand command={`npm run cli -- session show ${session.id} --limit ${limit}`} />
            <p className="muted-caption">
              Starts a fresh latest page for this investigation. Follow the returned cursors to
              browse the same captured-event snapshot.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
