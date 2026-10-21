import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Compile } from 'typebox/compile';
import { IdSchema, SessionHandoverSchema, type HandoverEvent } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { SessionNoteContent } from '@/components/session-note-content';
import { DateLabel, ErrorState, PageHeading, StatusBadge } from '@/components/ui';
import { RefreshButton } from '@/components/controls';
import { Icon } from '@/components/icon';
import styles from './handover.module.css';

export const dynamic = 'force-dynamic';

function EventExcerpt({ event }: { event: HandoverEvent }) {
  return (
    <details className={styles.eventExcerpt}>
      <summary>Inspect retained context and excerpts</summary>
      <p className={styles.caption}>
        Working directory{event.cwdTruncated ? ' (excerpt)' : ''}:{' '}
        <code>{event.cwdExcerpt || 'Not retained'}</code>
        <br />
        Starting HEAD: <code>{event.git.commitSha ?? 'Not recorded'}</code>
        <br />
        Starting working tree:{' '}
        {event.git.dirty
          ? 'uncommitted changes'
          : event.git.error || !event.git.commitSha
            ? 'unknown (Git context unavailable)'
            : 'clean when observed'}
        {event.git.afterCommitSha !== undefined && (
          <>
            <br />
            After-command HEAD: <code>{event.git.afterCommitSha ?? 'Not available'}</code>
          </>
        )}
      </p>
      {event.git.error && <p className={styles.caption}>Git context warning: {event.git.error}</p>}
      {event.git.afterCommitSha !== undefined && (
        <p className={styles.caption}>
          HEAD values are separate observations. Different values do not establish which process
          moved HEAD.
        </p>
      )}
      <p className={styles.caption}>
        Original capture: {event.capture.complete ? 'complete' : 'incomplete'} · Truncation:{' '}
        {event.capture.truncatedBytes} bytes · Redaction applied:{' '}
        {event.capture.redacted ? 'yes' : 'no'}
      </p>
      {event.outcome.error && (
        <p className={styles.caption}>
          Startup/outcome error: {event.outcome.error.code} · {event.outcome.error.message}
        </p>
      )}
      {event.outputExcerpt ? (
        <pre
          className={styles.output}
          tabIndex={0}
          aria-label={`Output excerpt for sequence ${event.sequence}`}
        >
          {event.outputExcerpt}
        </pre>
      ) : (
        <p className={styles.caption}>
          {event.outputTruncated
            ? 'Output text was omitted from this bounded report.'
            : 'No output text is retained for this event.'}
        </p>
      )}
      {event.outputTruncated && (
        <p className={styles.caption}>
          The exported output is shortened. Inspect the original event for the retained command
          output.
        </p>
      )}
      {event.diffs.map((diff) => (
        <div key={diff.phase}>
          <p className={styles.caption}>
            {diff.phase === 'before' ? 'Before-command' : 'After-command'} diff · Export excerpt
            shortened: {diff.excerptTruncated ? 'yes' : 'no'} · Original diff capture truncation:{' '}
            {diff.capturedTruncatedBytes} bytes
          </p>
          <p className={styles.caption}>
            {diff.baselineCommitSha ? (
              <>
                Baseline commit: <code>{diff.baselineCommitSha}</code>
              </>
            ) : (
              'Baseline not recorded'
            )}
            . Captured tracked changes can include pre-existing or concurrent edits.
          </p>
          {diff.text ? (
            <pre
              className={styles.output}
              tabIndex={0}
              aria-label={`${diff.phase} diff excerpt for sequence ${event.sequence}`}
            >
              {diff.text}
            </pre>
          ) : (
            <p className={styles.caption}>No diff text is retained in this report.</p>
          )}
        </div>
      ))}
    </details>
  );
}

export default async function HandoverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!Compile(IdSchema).Check(id)) notFound();
  const result = await apiRequest(
    `/v1/sessions/${encodeURIComponent(id)}/handover`,
    SessionHandoverSchema,
    { timeoutMs: 30_000 },
  );
  if (!result.ok) {
    if (result.status === 404) notFound();
    return (
      <>
        <Link className="back-link" href={`/sessions/${encodeURIComponent(id)}`}>
          <Icon name="arrow" size={13} />
          Back to investigation
        </Link>
        <PageHeading
          title="Portable handover report"
          description="Prepare a personal copy of this investigation's evidence."
        />
        <ErrorState
          message={result.message}
          detail="The report could not be prepared. Return to the investigation or refresh to try again."
        />
        <RefreshButton />
      </>
    );
  }
  const report = result.data;
  const { coverage, recap } = report;
  const recapIds = new Set(recap.sources.map((source) => source.id));
  const noteIds = new Set(report.notes.flatMap((note) => note.sources.map((source) => source.id)));
  const noteLinkedExtras = report.events.filter(
    (event) => noteIds.has(event.eventId) && !recapIds.has(event.eventId),
  ).length;
  const events = [...report.events].sort((left, right) => left.sequence - right.sequence);
  const downloadBase = `/api/sessions/${encodeURIComponent(report.session.id)}/handover`;
  return (
    <>
      <Link className="back-link" href={`/sessions/${encodeURIComponent(report.session.id)}`}>
        <Icon name="arrow" size={13} />
        Back to investigation
      </Link>
      <div className={styles.pageHeading}>
        <PageHeading
          eyebrow="PERSONAL · PORTABLE REPORT"
          title="Investigation handover"
          description={report.session.title}
          action={<RefreshButton />}
        />
      </div>
      <div className={styles.notice}>
        <p>
          A personal, portable copy of accepted investigation evidence. A downloaded copy will not
          change or disappear if its original records are later deleted.
        </p>
        <p>
          This is a bounded report with excerpts, not a full backup. Downloading saves a file
          through your browser; it does not upload the report to another service.
        </p>
      </div>
      <div className={styles.actions}>
        <a className="button button-small" href={`${downloadBase}?format=markdown`} download>
          <Icon name="repo" size={13} />
          Download Markdown
        </a>
        <a
          className="button button-small button-ghost"
          href={`${downloadBase}?format=json`}
          download
        >
          <Icon name="code" size={13} />
          Download JSON
        </a>
      </div>
      <p className={`${styles.caption} section-top`}>
        Report prepared <DateLabel value={report.generatedAt} />. Each download computes a fresh
        snapshot, so later uploads or notes may change its contents.
      </p>

      <section className={`panel ${styles.panel}`} aria-labelledby="handover-identity">
        <h2 id="handover-identity">Repository and investigation</h2>
        <dl className={styles.identity}>
          <div>
            <dt>Repository</dt>
            <dd>
              <Link
                className="inline-link"
                href={`/repositories/${encodeURIComponent(report.repository.id)}`}
              >
                {report.repository.name} <Icon name="arrow" size={11} />
              </Link>
              <br />
              <code>{report.repository.id}</code>
            </dd>
          </div>
          <div>
            <dt>Investigation</dt>
            <dd>
              {report.session.title}
              <br />
              <code>{report.session.id}</code>
            </dd>
          </div>
          <div>
            <dt>Repository remote</dt>
            <dd>
              <code>{report.repository.remoteUrl ?? 'No remote recorded'}</code>
            </dd>
          </div>
          <div>
            <dt>Session state</dt>
            <dd>
              <StatusBadge status={report.session.status} /> · Started{' '}
              <DateLabel value={report.session.createdAt} />
              {report.session.closedAt && (
                <>
                  {' '}
                  · Closed <DateLabel value={report.session.closedAt} />
                </>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className={`panel ${styles.panel}`} aria-labelledby="handover-coverage">
        <h2 id="handover-coverage">Portable report coverage</h2>
        <dl className={styles.coverage}>
          <div>
            <dt>Command events included</dt>
            <dd>
              {coverage.includedEvents} <small>/ {coverage.totalEvents}</small>
            </dd>
          </div>
          <div>
            <dt>Author reports included</dt>
            <dd>
              {coverage.includedNotes} <small>/ {coverage.totalNotes}</small>
            </dd>
          </div>
          <div>
            <dt>Additional note-linked commands</dt>
            <dd>{noteLinkedExtras}</dd>
          </div>
        </dl>
        <p className={styles.caption}>
          {coverage.omittedEvents} command event{coverage.omittedEvents === 1 ? '' : 's'} and{' '}
          {coverage.omittedNotes} author report{coverage.omittedNotes === 1 ? '' : 's'} omitted.{' '}
          {coverage.selection === 'all'
            ? 'All accepted command events are included.'
            : 'Command selection includes the first and latest recap attempts plus commands linked by the included author reports.'}{' '}
          The report holds at most {coverage.eventLimit} events and the latest {coverage.noteLimit}{' '}
          author reports.
        </p>
        <p className={styles.caption}>
          {coverage.recapEvents} included commands belong to the recap window.{' '}
          {report.excerptLimit === 0
            ? 'Output and diff excerpts were omitted to keep this report within its size limit.'
            : `Output and diff excerpts retain up to ${report.excerptLimit} characters per field.`}{' '}
          Compact JSON is bounded to {report.serializedByteLimit / 1024 / 1024} MiB; formatted
          downloads are bounded to 8 MiB. Repository file contents and derived memories are
          excluded.
        </p>
      </section>

      <section className={`panel ${styles.panel}`} aria-labelledby="handover-recap">
        <h2 id="handover-recap">Observed investigation recap</h2>
        <span className={styles.label}>{recap.label}</span>
        <p className={styles.summary}>{recap.summary}</p>
        <p className={styles.caption}>
          Recap coverage: {recap.coverage.includedEvents} of {recap.coverage.totalEvents} commands,
          with {recap.coverage.omittedEvents} omitted from the recap. These outcome counts describe
          the recap window, independently of the wider export coverage above.
        </p>
        {recap.coverage.includedEvents > 0 && (
          <div className={styles.counts}>
            <span>{recap.counts.passed} passed</span>
            <span>{recap.counts.failed} failed</span>
            <span>{recap.counts.interrupted} interrupted</span>
            <span>{recap.counts.spawnFailed} could not start</span>
            <span>{recap.counts.incomplete} incomplete outcomes</span>
            <span>{recap.counts.withDiffs} with diffs</span>
            <span>{recap.counts.incompleteCapture} incomplete captures</span>
          </div>
        )}
        <p className={styles.caption}>
          Diff and capture flags can overlap outcome counts. A passing command alone does not prove
          the issue was fixed.
        </p>
        {recap.uncertainty.length > 0 && (
          <ul className={styles.uncertainty}>
            {recap.uncertainty.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        )}
      </section>

      <section className={`panel ${styles.panel}`} aria-labelledby="handover-notes">
        <h2 id="handover-notes">Latest author reports</h2>
        <p className={styles.caption}>
          {coverage.includedNotes} of {coverage.totalNotes} saved report
          {coverage.totalNotes === 1 ? '' : 's'} included. Notes, decisions, and reported
          resolutions remain user-authored and not independently verified.
        </p>
        {report.notes.length ? (
          <details className={styles.disclosure} open={report.notes.length <= 2}>
            <summary>
              Read {report.notes.length} included author report
              {report.notes.length === 1 ? '' : 's'}
            </summary>
            {report.notes.map((note) => (
              <SessionNoteContent key={note.id} note={note} />
            ))}
          </details>
        ) : (
          <p className={styles.caption}>
            No author reports are included in this investigation handover.
          </p>
        )}
      </section>

      <section className={`panel ${styles.panel}`} aria-labelledby="handover-events">
        <h2 id="handover-events">Included command evidence</h2>
        <p className={styles.caption}>
          {coverage.includedEvents} included command event{coverage.includedEvents === 1 ? '' : 's'}{' '}
          in recorded sequence order. Original event links open the retained evidence in this local
          workspace.
        </p>
        {events.length ? (
          <details className={styles.disclosure} open={events.length <= 5}>
            <summary>
              Inspect {events.length} included command{events.length === 1 ? '' : 's'} and their
              excerpts
            </summary>
            <ol className={styles.events}>
              {events.map((event) => (
                <li className={styles.event} key={event.eventId}>
                  <span className={styles.sequence} aria-label={`Sequence ${event.sequence}`}>
                    {event.sequence}
                  </span>
                  <div className={styles.eventBody}>
                    <Link
                      href={`/events/${encodeURIComponent(event.eventId)}`}
                      className={styles.command}
                      prefetch={false}
                    >
                      {event.commandExcerpt || 'Command text unavailable'}
                    </Link>
                    <div className={styles.eventMeta}>
                      <span>
                        {event.outcome.kind} · Exit {event.outcome.exitCode ?? 'unavailable'}
                        {event.outcome.signal ? ` · Signal ${event.outcome.signal}` : ''}
                      </span>
                      <span>
                        <DateLabel value={event.startedAt} />
                      </span>
                      {recapIds.has(event.eventId) && <span>Recap selection</span>}
                      {noteIds.has(event.eventId) && <span>Linked from an author report</span>}
                      {event.commandTruncated && <span>Command text shortened</span>}
                      {!event.capture.complete && <span>Original capture incomplete</span>}
                    </div>
                    <EventExcerpt event={event} />
                    <Link
                      href={`/events/${encodeURIComponent(event.eventId)}`}
                      className="inline-link"
                      prefetch={false}
                    >
                      Open original event <Icon name="arrow" size={11} />
                      <span className="sr-only"> {event.sequence}</span>
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          </details>
        ) : (
          <p className={styles.caption}>
            No accepted command evidence is included yet. Capture and upload commands in the
            investigation, then prepare a fresh report.
          </p>
        )}
      </section>

      {report.notices.length > 0 && (
        <section className={`panel ${styles.panel}`} aria-labelledby="handover-notices">
          <h2 id="handover-notices">Report scope and conditions</h2>
          <ul className={styles.uncertainty}>
            {report.notices.map((notice, index) => (
              <li key={index}>{notice}</li>
            ))}
          </ul>
        </section>
      )}
      <div className={styles.footer}>
        <a className="button button-small" href={`${downloadBase}?format=markdown`} download>
          Download Markdown <Icon name="arrow" size={12} />
        </a>
        <a
          className="button button-small button-ghost"
          href={`${downloadBase}?format=json`}
          download
        >
          Download JSON <Icon name="arrow" size={12} />
        </a>
        <Link
          href={`/sessions/${encodeURIComponent(report.session.id)}#investigation-journal`}
          className="inline-link"
        >
          Return to investigation journal <Icon name="arrow" size={12} />
        </Link>
      </div>
    </>
  );
}
