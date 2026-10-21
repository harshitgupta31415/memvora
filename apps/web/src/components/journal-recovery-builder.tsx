'use client';

import { useState } from 'react';
import {
  journalRecoveryCommands,
  type JournalRecoveryInput,
} from '@/lib/journal-recovery-commands';
import { CopyCommand } from './controls';
import styles from './capture-recovery-builder.module.css';

export function JournalRecoveryBuilder({
  listPrefix,
  retryPrefix,
}: {
  listPrefix: string;
  retryPrefix: string | null;
}) {
  const [input, setInput] = useState<JournalRecoveryInput>({
    directory: '',
    state: 'pending',
    after: '',
    noteId: '',
  });
  const [shown, setShown] = useState(false);
  const commands = journalRecoveryCommands(input, { list: listPrefix, retry: retryPrefix });
  function change(key: keyof JournalRecoveryInput, value: string) {
    setInput((previous) => ({ ...previous, [key]: value }));
    setShown(false);
  }
  return (
    <section className={`panel ${styles.builder}`} aria-labelledby="journal-recovery-builder-title">
      <h2 id="journal-recovery-builder-title">Build commands for queued journal notes</h2>
      <p className={styles.help}>
        Enter only a folder and optional note UUID. This page does not collect note text, inspect
        local files, persist these fields, or submit a note. Fields reset on reload.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setShown(true);
        }}
      >
        <div className={styles.field}>
          <label htmlFor="journal-recovery-directory">Original bound capture folder</label>
          <input
            id="journal-recovery-directory"
            value={input.directory}
            onChange={(event) => change('directory', event.target.value)}
            placeholder="C:\Projects\your-repository"
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="journal-recovery-directory-help"
            aria-invalid={shown && Boolean(commands.errors.directory)}
          />
          <p id="journal-recovery-directory-help">
            Use the codebase where the note was queued, with its existing .memvora binding.
          </p>
          {shown && commands.errors.directory && (
            <p className="form-error">{commands.errors.directory}</p>
          )}
        </div>
        <fieldset className={styles.group}>
          <legend>Read-only offline journal listing</legend>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label htmlFor="journal-recovery-state">Local note state</label>
              <select
                id="journal-recovery-state"
                value={input.state}
                onChange={(event) => change('state', event.target.value)}
              >
                <option value="pending">Pending — no exact acknowledgement recorded</option>
                <option value="synced">Synced — historical acknowledgement recorded</option>
                <option value="all">All retained local notes</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="journal-recovery-after">Next row ID (optional)</label>
              <input
                id="journal-recovery-after"
                value={input.after}
                onChange={(event) => change('after', event.target.value)}
                placeholder="Use page.nextAfter from the previous list"
                inputMode="numeric"
                maxLength={16}
                autoComplete="off"
                aria-invalid={shown && Boolean(commands.errors.after)}
              />
              {shown && commands.errors.after && (
                <p className="form-error">{commands.errors.after}</p>
              )}
            </div>
          </div>
          <p className={styles.help}>
            Lists up to 20 metadata rows, oldest local row first. It needs no server, token or
            environment file and does not initialize or migrate a queue.
          </p>
        </fieldset>
        <fieldset className={styles.group}>
          <legend>Optional selected-note retry</legend>
          <div className={styles.field}>
            <label htmlFor="journal-recovery-note">Exact queued note UUID</label>
            <input
              id="journal-recovery-note"
              value={input.noteId}
              onChange={(event) => change('noteId', event.target.value)}
              placeholder="Copy the note ID from the journal list"
              maxLength={36}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="journal-recovery-note-help"
              aria-invalid={shown && Boolean(input.noteId) && Boolean(commands.errors.noteId)}
            />
            {shown && input.noteId && commands.errors.noteId && (
              <p className="form-error">{commands.errors.noteId}</p>
            )}
            <p id="journal-recovery-note-help">
              Leave empty to generate only the offline list. An older queued note can be selected;
              retry does not require it to belong to the current investigation.
            </p>
          </div>
        </fieldset>
        <button type="submit" className="button button-primary">
          Show journal commands
        </button>
      </form>
      {shown && (
        <div className={styles.results}>
          <h3>1. Inspect retained journal metadata</h3>
          {commands.listCommand ? (
            <div id="memvora-journal-list-command">
              <CopyCommand command={commands.listCommand} />
            </div>
          ) : (
            <p className="form-error" role="status">
              Correct the folder and list fields to generate an offline command.
            </p>
          )}
          <h3>2. Retry one original note</h3>
          {!retryPrefix ? (
            <p className="form-error">
              Retry is unavailable until local API configuration is corrected. Offline listing
              remains available.
            </p>
          ) : commands.retryCommand ? (
            <div id="memvora-journal-retry-command">
              <CopyCommand command={commands.retryCommand} />
            </div>
          ) : (
            <p className={styles.help}>
              Enter a valid note UUID to generate its retry command. Listing does not require one.
            </p>
          )}
          {commands.retryCommand && (
            <p className={styles.help}>
              Run this separately after inspection. It enters the original folder, retries only this
              UUID against the configured API, then restores your previous location. List state and
              row cursor do not change the retry selection.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
