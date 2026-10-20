import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RepositoryListSchema, SessionContextSchema } from '@memvora/contracts';
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
import { CopyCommand, RefreshButton } from '@/components/controls';

export const dynamic = 'force-dynamic';

export default async function Investigation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [result, repositories] = await Promise.all([
    apiRequest(`/v1/sessions/${encodeURIComponent(id)}`, SessionContextSchema),
    apiRequest('/v1/repositories', RepositoryListSchema),
  ]);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <ErrorState message={result.message} />;
  }
  const { session, events, memories } = result.data;
  const partialTimeline = session.eventCount > events.length;
  const repository = repositories.ok
    ? repositories.data.items.find((repo) => repo.id === session.repositoryId)
    : undefined;
  return (
    <>
      <Link href="/sessions" className="back-link">
        <Icon name="arrow" size={13} />
        All investigations
      </Link>
      <PageHeading
        eyebrow={repository?.name ?? 'INVESTIGATION'}
        title={session.title}
        description="Original attempts and their recorded outcomes, with linked memory alongside."
        action={<RefreshButton />}
      />
      <div className="detail-meta">
        <StatusBadge status={session.status} />
        <span>
          Started <DateLabel value={session.createdAt} />
        </span>
        <span className="meta-divider">/</span>
        <span>
          {session.eventCount} recorded command{events.length === 1 ? '' : 's'}
        </span>
        <span className="meta-divider">/</span>
        <span>
          {memories.length} memor{memories.length === 1 ? 'y' : 'ies'}
        </span>
      </div>
      <div className="section-top">
        {partialTimeline && (
          <div className="notice notice-neutral">
            <Icon name="clock" size={17} />
            <div>
              <strong>Showing the most recent {events.length} commands.</strong>
              <p>
                This investigation contains {session.eventCount} events. Earlier source details
                remain available through recall and their direct event links. This view currently
                has no pagination.
              </p>
              <Link href="/ask" className="inline-link">
                Search earlier evidence <Icon name="arrow" size={12} />
              </Link>
            </div>
          </div>
        )}
      </div>
      <div className="two-column section-top">
        <section className="panel section-padding">
          <SectionHeading
            title="Investigation timeline"
            description="Commands stay separate, including repeated attempts."
          />
          {events.length ? (
            <ol className="timeline">
              {[...events]
                .sort((a, b) => a.sequence - b.sequence)
                .map((event) => (
                  <li className="timeline-item" key={event.eventId}>
                    <span className="timeline-point">
                      {String(event.sequence).padStart(2, '0')}
                    </span>
                    <div className="timeline-body">
                      <div className="timeline-top">
                        <Link className="timeline-command mono" href={`/events/${event.eventId}`}>
                          {event.command.executable} {event.command.args.join(' ')}
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
                        <pre className="timeline-output">
                          {event.output
                            .map((chunk) => chunk.text)
                            .join('')
                            .slice(0, 900)}
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
              title="This investigation is waiting for evidence."
              description="Run a command through Memvora while this session is active. Output and outcome will be recorded here."
            />
          )}
        </section>
        <aside className="content-stack">
          <section className="panel section-padding">
            <SectionHeading
              title="Linked memory"
              description="Derived from recorded evidence. Original events remain authoritative."
            />
            <p className="muted-caption">
              <Link href={`/jobs?sessionId=${session.id}`} className="inline-link">
                Check summary processing <Icon name="arrow" size={11} />
              </Link>
            </p>
            {memories.length ? (
              memories.map((memory) => <MemoryCard key={memory.id} memory={memory} />)
            ) : (
              <EmptyState
                icon="link"
                title="No linked memory yet."
                description="The worker creates a memory after evidence is uploaded. Raw commands remain available while processing."
              />
            )}
          </section>
          <section className="panel section-padding">
            <SectionHeading title="Continue in the terminal" />
            <CopyCommand command={`npm run cli -- ask "What happened in this investigation?"`} />
            <p className="muted-caption">
              Run in the bound repository. This command asks for history; it does not execute an
              earlier fix.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
