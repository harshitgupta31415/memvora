import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EventResponseSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import { DateLabel, ErrorState, PageHeading, SectionHeading, StatusBadge } from '@/components/ui';
import { CopyCommand } from '@/components/controls';

export const dynamic = 'force-dynamic';

export default async function EventDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiRequest(`/v1/events/${encodeURIComponent(id)}`, EventResponseSchema);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <ErrorState message={result.message} />;
  }
  const { event } = result.data;
  const duration = Math.max(
    0,
    new Date(event.endedAt).getTime() - new Date(event.startedAt).getTime(),
  );
  return (
    <>
      <Link href={`/sessions/${event.sessionId}`} className="back-link">
        <Icon name="arrow" size={13} />
        Back to investigation
      </Link>
      <PageHeading
        eyebrow={`ORIGINAL EVIDENCE / COMMAND ${String(event.sequence).padStart(2, '0')}`}
        title="An attempt, exactly as recorded."
        description="Inspect output, code conditions, and observed outcome before reusing an earlier approach."
        action={
          <StatusBadge
            status={
              event.outcome.kind === 'completed' && event.outcome.exitCode !== 0
                ? 'failed'
                : event.outcome.kind
            }
          />
        }
      />
      {(!event.capture.complete || event.capture.truncatedBytes > 0) && (
        <div className="notice notice-warning">
          <Icon name="alert" size={18} />
          <div>
            <strong>This capture is {event.capture.complete ? 'truncated' : 'incomplete'}.</strong>
            <p>
              {event.capture.truncatedBytes.toLocaleString()} bytes were not retained. Missing
              evidence must not be treated as a successful outcome.
            </p>
          </div>
        </div>
      )}
      <div className="two-column">
        <div className="content-stack">
          <section className="panel section-padding">
            <SectionHeading
              title="Captured command"
              description="Text is evidence. Nothing on this page executes the command."
            />
            <CopyCommand
              command={[
                event.command.executable,
                ...event.command.args.map((arg) => (/\s/u.test(arg) ? JSON.stringify(arg) : arg)),
              ].join(' ')}
            />
            {event.outcome.error && (
              <p className="form-error section-top">
                {event.outcome.error.code}: {event.outcome.error.message}
              </p>
            )}
          </section>
          <section>
            <SectionHeading
              title="Terminal output"
              description="stdout and stderr are preserved as distinct captured chunks."
            />
            <div className="code-panel">
              <div className="code-panel-heading">
                <span>Recorded output</span>
                <span>
                  {event.output.length} chunk{event.output.length === 1 ? '' : 's'}
                </span>
              </div>
              <pre className="output-block">
                {event.output.length ? (
                  [...event.output]
                    .sort((a, b) => a.ordinal - b.ordinal)
                    .map((chunk) => (
                      <span
                        key={`${chunk.ordinal}-${chunk.stream}`}
                        className={`output-chunk ${chunk.stream === 'stderr' ? 'output-stderr' : ''}`}
                      >
                        <span className="sr-only">{chunk.stream}: </span>
                        {chunk.text}
                      </span>
                    ))
                ) : (
                  <span className="output-empty">No output was recorded for this attempt.</span>
                )}
              </pre>
            </div>
          </section>
          {event.diffs.map((diff) => (
            <section key={diff.phase}>
              <SectionHeading
                title={`Code changes ${diff.phase === 'before' ? 'before' : 'after'} the command`}
                description="Recorded local diff; includes only captured tracked changes."
              />
              <div className="code-panel">
                <div className="code-panel-heading">
                  <span>{diff.phase === 'before' ? 'Starting' : 'Ending'} diff</span>
                  <span>
                    {diff.truncatedBytes > 0
                      ? `${diff.truncatedBytes} bytes truncated`
                      : 'Captured diff'}
                  </span>
                </div>
                <pre className="output-block">
                  {diff.text || <span className="output-empty">No tracked diff was recorded.</span>}
                </pre>
              </div>
            </section>
          ))}
        </div>
        <aside className="content-stack">
          <section className="panel section-padding">
            <SectionHeading title="Execution context" />
            <ul className="provenance">
              <li>
                <span>Started</span>
                <span>
                  <DateLabel value={event.startedAt} />
                </span>
              </li>
              <li>
                <span>Duration</span>
                <span>{(duration / 1000).toFixed(2)} seconds</span>
              </li>
              <li>
                <span>Outcome</span>
                <span>{event.outcome.kind.replaceAll('_', ' ')}</span>
              </li>
              <li>
                <span>Exit code</span>
                <span className="mono">{event.outcome.exitCode ?? 'Not available'}</span>
              </li>
              <li>
                <span>Signal</span>
                <span>{event.outcome.signal ?? 'None recorded'}</span>
              </li>
              <li>
                <span>Shell</span>
                <span className="mono">{event.command.shell || 'Direct executable'}</span>
              </li>
              <li>
                <span>Directory</span>
                <span className="mono">{event.cwd}</span>
              </li>
              <li>
                <span>Commit</span>
                <span className="mono">{event.git.commitSha ?? 'Not available'}</span>
              </li>
              <li>
                <span>Working tree</span>
                <span>{event.git.dirty ? 'Uncommitted changes' : 'Clean when observed'}</span>
              </li>
              <li>
                <span>Redaction</span>
                <span>
                  {event.capture.redacted ? 'Processed at capture' : 'Not marked as processed'}
                </span>
              </li>
            </ul>
            {event.git.error && <p className="muted-caption">Git context: {event.git.error}</p>}
          </section>
          <div className="notice notice-neutral">
            <Icon name="link" size={17} />
            <div>
              <strong>Evidence, with its limits.</strong>
              <p>
                An exit code records what happened. It does not establish a root cause or prove that
                a particular change fixed the issue. Redaction cannot guarantee detection of every
                secret.
              </p>
            </div>
          </div>
          <p className="request-id">Event {event.eventId}</p>
        </aside>
      </div>
    </>
  );
}
