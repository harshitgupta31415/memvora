import 'server-only';
import Link from 'next/link';
import { Compile } from 'typebox/compile';
import { IdSchema, SessionNotesPageSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { SessionNoteContent } from './session-note-content';
import { SessionNoteComposer, type JournalCommandOption } from './session-note-form';
import { RefreshButton } from './controls';
import { Icon } from './icon';
import styles from './session-journal.module.css';

export function SessionJournalLoading() {
  return (
    <section
      className={`panel section-top ${styles.journal}`}
      aria-label="Investigation journal"
      aria-busy="true"
    >
      <div className={styles.heading}>
        <h2>Investigation journal</h2>
      </div>
      <p className={styles.caption} role="status">
        Loading user-authored reports…
      </p>
    </section>
  );
}

export async function SessionJournal({
  sessionId,
  noteBefore,
  timelineLimit,
  timelineCursor,
  commands,
}: {
  sessionId: string;
  noteBefore: string | string[] | undefined;
  timelineLimit: number;
  timelineCursor: string | undefined;
  commands: JournalCommandOption[];
}) {
  function href(before?: string): string {
    const query = new URLSearchParams({ limit: String(timelineLimit) });
    if (timelineCursor !== undefined) query.set('cursor', timelineCursor);
    if (before !== undefined) query.set('noteBefore', before);
    return `/sessions/${encodeURIComponent(sessionId)}?${query}#investigation-journal`;
  }
  const latestHref = href();
  const invalidBefore =
    noteBefore !== undefined &&
    (typeof noteBefore !== 'string' || !Compile(IdSchema).Check(noteBefore));
  const query = new URLSearchParams({ limit: '20' });
  if (typeof noteBefore === 'string' && !invalidBefore) query.set('before', noteBefore);
  const result = invalidBefore
    ? null
    : await apiRequest(
        `/v1/sessions/${encodeURIComponent(sessionId)}/notes?${query}`,
        SessionNotesPageSchema,
      );
  return (
    <section
      id="investigation-journal"
      className={`panel section-top ${styles.journal}`}
      aria-labelledby="investigation-journal-title"
    >
      <div className={styles.heading}>
        <div>
          <h2 id="investigation-journal-title">Investigation journal</h2>
          <p>
            Notes, decisions, and reported resolutions written by the workspace user. These reports
            remain separate from recorded command evidence and observed recaps.
          </p>
        </div>
        <RefreshButton />
      </div>
      <p className={styles.notice}>
        User-authored reports are not independently verified. Journal pages are live: new reports
        can change the total while you browse. Command timeline pagination keeps its own snapshot.
      </p>
      {!result || !result.ok ? (
        <div>
          <p className={styles.error} role="alert">
            {invalidBefore
              ? 'This journal page link is invalid.'
              : result && !result.ok
                ? result.message
                : 'The journal is unavailable.'}
          </p>
          <p className={styles.caption}>The command timeline remains available below.</p>
          <Link href={latestHref} className="inline-link" prefetch={false}>
            Return to latest journal entries <Icon name="arrow" size={12} />
          </Link>
        </div>
      ) : (
        <>
          <p className={styles.count}>
            Showing {result.data.items.length} of {result.data.totalNotes} saved report
            {result.data.totalNotes === 1 ? '' : 's'} ·{' '}
            {noteBefore ? 'Earlier journal page' : 'Latest journal page'}
          </p>
          {result.data.items.length ? (
            result.data.items.map((note) => <SessionNoteContent key={note.id} note={note} />)
          ) : (
            <div className={styles.empty}>
              <p className={styles.caption}>
                {result.data.totalNotes === 0
                  ? 'No author reports have been saved for this investigation. Add a note below when you have context to preserve.'
                  : 'No reports were returned on this page. Return to the latest journal entries.'}
              </p>
            </div>
          )}
          <nav className={styles.pagination} aria-label="Investigation journal pages">
            {result.data.olderBeforeId ? (
              <Link
                href={href(result.data.olderBeforeId)}
                className="button button-small button-ghost"
                prefetch={false}
              >
                <Icon name="arrow" size={12} style={{ transform: 'rotate(180deg)' }} />
                Older reports
              </Link>
            ) : (
              <span
                className="button button-small button-ghost button-disabled"
                aria-disabled="true"
              >
                Oldest reports reached
              </span>
            )}
            {noteBefore ? (
              <Link href={latestHref} className="button button-small button-ghost" prefetch={false}>
                Latest journal entries <Icon name="arrow" size={12} />
              </Link>
            ) : (
              <span className={styles.caption}>
                Latest entries · refresh to include new reports
              </span>
            )}
          </nav>
          <SessionNoteComposer
            key={sessionId}
            initiallyOpen={result.data.totalNotes === 0}
            sessionId={sessionId}
            commands={commands}
            latestJournalHref={latestHref}
          />
        </>
      )}
    </section>
  );
}
