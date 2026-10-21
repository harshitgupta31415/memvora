import Link from 'next/link';
import type { SessionNote } from '@memvora/contracts';
import { noteKindLabel } from '@/lib/note-labels';
import { SourceLinks } from './evidence';
import { DateLabel } from './ui';
import { Icon } from './icon';
import styles from './session-journal.module.css';

export function SessionNoteContent({
  note,
  showPermalink = true,
}: {
  note: SessionNote;
  showPermalink?: boolean;
}) {
  return (
    <article className={styles.note}>
      <div className={styles.noteHeading}>
        <h3>{noteKindLabel(note.kind)}</h3>
        <span className={styles.reportLabel}>{note.label}</span>
      </div>
      <p className={styles.author}>
        Reported by <strong>{note.author.name}</strong> · <DateLabel value={note.createdAt} />
      </p>
      <p className={styles.body}>{note.body}</p>
      <div className={styles.evidence}>
        <p>
          {note.sources.length
            ? `${note.sources.length} linked command${note.sources.length === 1 ? '' : 's'}. These observations do not independently verify the report.`
            : 'No command evidence is linked to this report.'}
        </p>
        {note.sources.length > 0 && (
          <SourceLinks ids={note.sources.map((source) => source.id)} sources={note.sources} />
        )}
      </div>
      {showPermalink && (
        <Link
          className="inline-link"
          href={`/notes/${encodeURIComponent(note.id)}`}
          prefetch={false}
        >
          Open author report <Icon name="arrow" size={11} />
        </Link>
      )}
    </article>
  );
}
