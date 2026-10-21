'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Compile } from 'typebox/compile';
import {
  CreateSessionNoteSchema,
  IdSchema,
  SessionNoteResponseSchema,
  type CreateSessionNote,
} from '@memvora/contracts';
import { submitJson } from '@/lib/client-api';
import { noteKindLabel } from '@/lib/note-labels';
import { Icon } from './icon';
import styles from './session-journal.module.css';

export type JournalCommandOption = { eventId: string; sequence: number; command: string };

export function SessionNoteComposer({
  initiallyOpen,
  ...props
}: {
  initiallyOpen: boolean;
  sessionId: string;
  commands: JournalCommandOption[];
  latestJournalHref: string;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  return (
    <details
      className={styles.composer}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Add a note, decision, or reported resolution</summary>
      <SessionNoteForm {...props} />
    </details>
  );
}

export function SessionNoteForm({
  sessionId,
  commands,
  latestJournalHref,
}: {
  sessionId: string;
  commands: JournalCommandOption[];
  latestJournalHref: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<CreateSessionNote['kind']>('note');
  const [body, setBody] = useState('');
  const [eventText, setEventText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<{ id: string; kind: CreateSessionNote['kind'] } | null>(null);
  const submissionId = useRef<string | null>(null);
  function edited() {
    // Keep identity on retries; every edit starts a different user-authored report.
    submissionId.current = null;
    setError('');
    setSaved(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSaved(null);
    const eventIds = eventText.split(/[\s,]+/u).filter(Boolean);
    if (!body.trim() || body.length > 4000) {
      setError('Write 1–4000 characters for the report.');
      return;
    }
    if (
      eventIds.length > 10 ||
      new Set(eventIds).size !== eventIds.length ||
      eventIds.some((id) => !Compile(IdSchema).Check(id))
    ) {
      setError(
        'Link up to 10 distinct command IDs from this investigation. Use commas or spaces between IDs.',
      );
      return;
    }
    setPending(true);
    try {
      submissionId.current ??= crypto.randomUUID();
      const input = { id: submissionId.current, kind, body, eventIds };
      if (!Compile(CreateSessionNoteSchema).Check(input))
        throw new Error('Check the report kind, text, and linked command IDs.');
      const result = await submitJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/notes`,
        input,
        SessionNoteResponseSchema,
      );
      if (result.note.id !== input.id || result.note.sessionId !== sessionId)
        throw new Error(
          'The save response could not be matched to this report. Retry the same draft.',
        );
      setSaved({ id: result.note.id, kind: result.note.kind });
      setBody('');
      setEventText('');
      setKind('note');
      submissionId.current = null;
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The report could not be saved. Retry the same draft.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      <fieldset disabled={pending}>
        <div className={styles.formHeader}>
          <label className={styles.field}>
            <span>Report kind</span>
            <select
              className="select"
              value={kind}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'note' || value === 'decision' || value === 'resolution') {
                  edited();
                  setKind(value);
                }
              }}
            >
              <option value="note">Note</option>
              <option value="decision">Decision</option>
              <option value="resolution">Reported resolution</option>
            </select>
          </label>
          <p className={styles.caption}>
            Describe what you observed, chose, or believe resolved the issue. Your report is
            self-reported and not independently verified.
          </p>
        </div>
        <label className={styles.field}>
          <span>Report text</span>
          <textarea
            className="input"
            rows={5}
            required
            maxLength={4000}
            value={body}
            onChange={(event) => {
              edited();
              setBody(event.target.value);
            }}
            placeholder="What should you or another engineer know when returning to this investigation?"
          />
          <small>
            {body.length}/4000 characters. Text is stored as an author report, not captured
            reasoning.
          </small>
        </label>
        {commands.length > 0 && (
          <label className={styles.field}>
            <span>Add command evidence from the current timeline page</span>
            <select
              className="select"
              value=""
              onChange={(event) => {
                const id = event.target.value;
                if (!id || eventText.split(/[\s,]+/u).includes(id)) return;
                edited();
                setEventText((current) => `${current.trim()}${current.trim() ? ', ' : ''}${id}`);
              }}
            >
              <option value="">Choose a command to link (optional)</option>
              {commands.map((command) => (
                <option key={command.eventId} value={command.eventId}>
                  #{command.sequence} ·{' '}
                  {command.command.length > 120
                    ? `${command.command.slice(0, 120)}…`
                    : command.command}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={styles.field}>
          <span>Linked command IDs (optional)</span>
          <textarea
            className="input mono"
            rows={2}
            maxLength={500}
            value={eventText}
            onChange={(event) => {
              edited();
              setEventText(event.target.value);
            }}
            placeholder="Paste up to 10 command event UUIDs, separated by commas or spaces"
          />
          <small>
            All linked commands must belong to this investigation. You can also paste IDs from other
            timeline pages.
          </small>
        </label>
      </fieldset>
      {error && (
        <div role="alert">
          <p className={styles.error}>{error}</p>
          <p className={styles.caption}>
            Your draft has been kept. Retry without editing to repeat the same save.
          </p>
        </div>
      )}
      {saved && (
        <div className={styles.result} role="status">
          <p>{noteKindLabel(saved.kind)} saved as a user-authored, unverified report.</p>
          <Link href={`/notes/${encodeURIComponent(saved.id)}`} className="inline-link">
            Inspect saved report <Icon name="arrow" size={11} />
          </Link>
          <Link href={latestJournalHref} className="inline-link" prefetch={false}>
            Latest journal entries <Icon name="arrow" size={11} />
          </Link>
        </div>
      )}
      <div className={styles.submit}>
        <button type="submit" className="button button-small" disabled={pending}>
          <Icon name={pending ? 'clock' : 'plus'} size={13} />
          {pending ? 'Saving…' : 'Save user report'}
        </button>
        <p className={styles.caption}>Drafts are kept only in this page until saved.</p>
      </div>
    </form>
  );
}
