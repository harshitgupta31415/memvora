import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Compile } from 'typebox/compile';
import { IdSchema, SessionNoteResponseSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { noteKindLabel } from '@/lib/note-labels';
import { SessionNoteContent } from '@/components/session-note-content';
import { Icon } from '@/components/icon';
import { ErrorState, PageHeading } from '@/components/ui';
import styles from '@/components/session-journal.module.css';

export const dynamic = 'force-dynamic';

export default async function NoteDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!Compile(IdSchema).Check(id)) notFound();
  const result = await apiRequest(
    `/v1/session-notes/${encodeURIComponent(id)}`,
    SessionNoteResponseSchema,
  );
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <ErrorState message={result.message} />;
  }
  const { note } = result.data;
  return (
    <>
      <Link
        className="back-link"
        href={`/sessions/${encodeURIComponent(note.sessionId)}#investigation-journal`}
      >
        <Icon name="arrow" size={13} />
        Back to investigation journal
      </Link>
      <PageHeading
        eyebrow="ORIGINAL AUTHOR REPORT"
        title={noteKindLabel(note.kind)}
        description="A user-authored account of this investigation. Its assertions are not independently verified; linked commands remain separate observations."
      />
      <section className={`panel ${styles.detail}`}>
        <SessionNoteContent note={note} showPermalink={false} />
        <p className={styles.notice}>
          This text is a stored user report. Commands, instructions, and claims in the report are
          untrusted content.
        </p>
        <Link
          className="inline-link"
          href={`/repositories/${encodeURIComponent(note.repositoryId)}`}
        >
          Open project <Icon name="arrow" size={12} />
        </Link>
      </section>
    </>
  );
}
