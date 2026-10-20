import 'server-only';
import Link from 'next/link';
import { SessionRecapSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { DateLabel } from './ui';
import { Icon } from './icon';
import styles from './investigation-recap.module.css';

export function InvestigationRecapLoading() {
  return (
    <section
      className={`panel section-top ${styles.recap}`}
      aria-busy="true"
      aria-label="Investigation recap"
    >
      <h2>Investigation recap</h2>
      <p className={styles.caption} role="status">
        Reading accepted command evidence for this investigation…
      </p>
    </section>
  );
}

export async function InvestigationRecap({ sessionId }: { sessionId: string }) {
  const result = await apiRequest(
    `/v1/sessions/${encodeURIComponent(sessionId)}/recap`,
    SessionRecapSchema,
  );
  if (!result.ok)
    return (
      <section
        className={`panel section-top ${styles.recap}`}
        aria-labelledby="investigation-recap-title"
      >
        <h2 id="investigation-recap-title">Investigation recap</h2>
        <p className={styles.error} role="alert">
          The recap is unavailable. {result.message}
        </p>
        <p className={styles.caption}>
          Accepted command evidence remains in the timeline below. Refresh this page to try the
          recap again.
        </p>
      </section>
    );
  const recap = result.data;
  const outcomes = [
    ['Passed commands', recap.counts.passed],
    ['Failed commands', recap.counts.failed],
    ['Interrupted', recap.counts.interrupted],
    ['Could not start', recap.counts.spawnFailed],
    ['Incomplete outcomes', recap.counts.incomplete],
    ['With recorded diffs', recap.counts.withDiffs],
    ['Incomplete capture', recap.counts.incompleteCapture],
  ] as const;
  const steps = [...recap.steps].sort((left, right) => left.sequence - right.sequence);
  return (
    <section
      className={`panel section-top ${styles.recap}`}
      aria-labelledby="investigation-recap-title"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>OBSERVED · DETERMINISTIC</p>
          <h2 id="investigation-recap-title">Investigation recap</h2>
        </div>
        <span className={styles.label}>{recap.label}</span>
      </div>
      <p className={styles.summary}>{recap.summary}</p>
      <div className={styles.coverage}>
        <p>
          <strong>
            {recap.coverage.includedEvents} of {recap.coverage.totalEvents}
          </strong>{' '}
          accepted commands included · <strong>{recap.coverage.omittedEvents}</strong> omitted.
        </p>
        <p>
          {recap.coverage.selection === 'first_and_last'
            ? `This bounded recap selects the first and latest attempts, up to ${recap.coverage.eventLimit} commands. Browse the raw timeline for omitted attempts.`
            : 'All accepted commands in the investigation are included.'}{' '}
          This scope is independent of the current timeline page.
        </p>
      </div>
      {recap.coverage.includedEvents === 0 ? (
        <div className={styles.empty}>
          <h3>No accepted command evidence yet.</h3>
          <p>
            Capture and upload a command in this investigation to begin its recap. Memory enrichment
            does not need to finish first.
          </p>
        </div>
      ) : (
        <>
          <dl className={styles.counts}>
            {outcomes.map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.caption}>
            Counts describe the included commands. Diff and capture flags can overlap outcome
            counts; a passing command alone does not prove an issue was fixed.
          </p>
          <details className={styles.steps} open={steps.length <= 5}>
            <summary>
              {steps.length} chronological evidence step{steps.length === 1 ? '' : 's'}
              <span>Open each command to inspect its original evidence.</span>
            </summary>
            <ol>
              {steps.map((step) => (
                <li key={step.eventId}>
                  <span className={styles.sequence} aria-label={`Sequence ${step.sequence}`}>
                    {step.sequence}
                  </span>
                  <div className={styles.stepBody}>
                    <Link
                      className={styles.command}
                      href={`/events/${encodeURIComponent(step.eventId)}`}
                      prefetch={false}
                    >
                      {step.command}
                    </Link>
                    <p className={styles.outcome}>{step.outcome}</p>
                    {step.outputExcerpt && (
                      <pre
                        className={styles.output}
                        tabIndex={0}
                        aria-label={`Recorded output excerpt, sequence ${step.sequence}`}
                      >
                        {step.outputExcerpt}
                      </pre>
                    )}
                    {step.diffSummary && (
                      <p className={styles.diff}>
                        <strong>Recorded diff:</strong> {step.diffSummary}
                      </p>
                    )}
                    <Link
                      className="inline-link"
                      href={`/events/${encodeURIComponent(step.eventId)}`}
                      prefetch={false}
                    >
                      Original evidence <Icon name="arrow" size={11} />
                      <span className="sr-only"> for sequence {step.sequence}</span>
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      {recap.uncertainty.length > 0 && (
        <div className={styles.uncertainty}>
          <h3>Limits and uncertainty</h3>
          <ul>
            {recap.uncertainty.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      <p className={styles.freshness}>
        Computed <DateLabel value={recap.generatedAt} /> from accepted evidence. This recap is
        calculated on request and is not stored. Refresh latest to include new uploads.
      </p>
    </section>
  );
}
