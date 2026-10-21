import Link from 'next/link';
import type { SessionSynthesisHistory } from '@memvora/contracts';
import { DateLabel } from './ui';
import { Icon } from './icon';
import { CopySynthesisIdentity } from './synthesis-identity';
import styles from './session-synthesis.module.css';

export function SessionSynthesisHistoryPanel({
  history,
  selectedRequestId,
}: {
  history: SessionSynthesisHistory;
  selectedRequestId?: string;
}) {
  const base = `/sessions/${encodeURIComponent(history.sessionId)}/synthesis`;
  return (
    <section className={`panel ${styles.history}`} aria-labelledby="synthesis-history-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>READ-ONLY REQUEST HISTORY</p>
          <h2 id="synthesis-history-title">Retained interpretation requests</h2>
        </div>
        <Link className="button button-small button-ghost" href={base} prefetch={false}>
          Open latest request <Icon name="arrow" size={12} />
        </Link>
      </div>
      <p className={styles.caption}>
        {history.retainedCount} / {history.requestLimit} retained requests · newest requested first.
        Opening a request never submits work or retries a provider attempt.
      </p>
      {!history.items.length ? (
        <p className={styles.caption}>
          No retained requests in this investigation. A request will appear here after explicit
          submission is accepted.
        </p>
      ) : (
        <>
          {history.retainedCount === history.requestLimit && (
            <p className={styles.warning}>
              This investigation has reached its retained request limit. Existing requests remain
              readable.
            </p>
          )}
          <details open={history.items.length <= 6} className={styles.historyDetails}>
            <summary>Browse all {history.items.length} retained requests</summary>
            <ol className={styles.historyList}>
              {history.items.map((item, index) => {
                const selected = item.id === selectedRequestId;
                return (
                  <li
                    className={selected ? styles.historySelected : styles.historyRow}
                    key={item.id}
                  >
                    <Link
                      className={styles.historyLink}
                      aria-current={selected ? 'page' : undefined}
                      href={`${base}?${new URLSearchParams({ requestId: item.id })}`}
                      prefetch={false}
                    >
                      <span className={styles.historyState}>
                        {item.status}
                        {item.stale ? ' · stale' : ''}
                        {index === 0 ? ' · latest' : ''}
                        {selected ? ' · selected' : ''}
                      </span>
                      <span className={styles.caption}>
                        <DateLabel value={item.createdAt} /> · {item.configuration.provider} /{' '}
                        {item.configuration.model}
                      </span>
                      <span className={styles.caption}>
                        {item.coverage.includedEvents} / {item.coverage.totalEvents} commands;{' '}
                        {item.coverage.includedNotes} / {item.coverage.totalNotes} notes ·{' '}
                        {item.attempts} / 1 provider attempt
                      </span>
                      <span className={styles.historyId}>Request {item.id}</span>
                      <span className={styles.historyId}>Input {item.inputHash}</span>
                      {item.failureCode && (
                        <span className={styles.caption}>Failure code: {item.failureCode}</span>
                      )}
                    </Link>
                    <CopySynthesisIdentity requestId={item.id} inputHash={item.inputHash} />
                  </li>
                );
              })}
            </ol>
          </details>
        </>
      )}
      <p className={styles.caption}>
        This list contains request metadata only. Open one request for its stored interpretation and
        original citations. Ready results remain unverified; stale describes changed evidence or
        configuration.
      </p>
    </section>
  );
}
