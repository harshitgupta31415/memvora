'use client';

import { useState } from 'react';
import { captureRecoveryCommands, type RecoveryInput } from '@/lib/capture-recovery-commands';
import { CopyCommand } from './controls';
import styles from './capture-recovery-builder.module.css';

export function CaptureRecoveryBuilder({
  listPrefix,
  syncPrefix,
}: {
  listPrefix: string;
  syncPrefix: string | null;
}) {
  const [input, setInput] = useState<RecoveryInput>({
    directory: '',
    state: 'unsynced',
    sessionId: '',
    after: '',
    syncKind: 'session',
    syncId: '',
  });
  const [shown, setShown] = useState(false);
  const commands = captureRecoveryCommands(input, { list: listPrefix, sync: syncPrefix });
  function change(key: keyof RecoveryInput, value: string) {
    setInput((previous) => ({ ...previous, [key]: value }));
    setShown(false);
  }
  return (
    <section className={`panel ${styles.builder}`} aria-labelledby="recovery-builder-title">
      <h2 id="recovery-builder-title">Build commands for one capture folder</h2>
      <p className={styles.help}>
        Paths and IDs stay in this browser and reset on reload. This checks their format only; it
        does not inspect the folder, send a request, or run a command.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setShown(true);
        }}
      >
        <div className={styles.field}>
          <label htmlFor="recovery-directory">Absolute capture folder</label>
          <input
            id="recovery-directory"
            value={input.directory}
            onChange={(event) => change('directory', event.target.value)}
            placeholder="C:\Projects\your-repository"
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="recovery-directory-help"
            aria-invalid={shown && Boolean(commands.errors.directory)}
          />
          <p id="recovery-directory-help">
            The target codebase containing its own .memvora folder, not the server data directory.
          </p>
          {shown && commands.errors.directory && (
            <p className="form-error">{commands.errors.directory}</p>
          )}
        </div>
        <fieldset className={styles.group}>
          <legend>Read-only local listing</legend>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label htmlFor="recovery-state">State</label>
              <select
                id="recovery-state"
                value={input.state}
                onChange={(event) => change('state', event.target.value)}
              >
                <option value="unsynced">Unsynced — pending + incomplete</option>
                <option value="pending">Pending — finalized, no local acknowledgement</option>
                <option value="incomplete">Incomplete — unfinished local capture</option>
                <option value="synced">Synced — locally acknowledged</option>
                <option value="all">All local rows</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="recovery-list-session">Session UUID filter (optional)</label>
              <input
                id="recovery-list-session"
                value={input.sessionId}
                onChange={(event) => change('sessionId', event.target.value)}
                placeholder="Copy a sessionId from the list"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={shown && Boolean(commands.errors.sessionId)}
              />
              {shown && commands.errors.sessionId && (
                <p className="form-error">{commands.errors.sessionId}</p>
              )}
            </div>
            <div className={styles.field}>
              <label htmlFor="recovery-after">Next row ID (optional)</label>
              <input
                id="recovery-after"
                value={input.after}
                onChange={(event) => change('after', event.target.value)}
                placeholder="Use page.nextAfter from the previous result"
                autoComplete="off"
                inputMode="numeric"
                maxLength={16}
                aria-invalid={shown && Boolean(commands.errors.after)}
              />
              {shown && commands.errors.after && (
                <p className="form-error">{commands.errors.after}</p>
              )}
            </div>
          </div>
          <p className={styles.help}>
            One live page of up to 20 metadata rows, oldest local row first.
          </p>
        </fieldset>
        <fieldset className={styles.group}>
          <legend>Optional selected upload</legend>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label htmlFor="recovery-sync-kind">Upload selection</label>
              <select
                id="recovery-sync-kind"
                value={input.syncKind}
                onChange={(event) => change('syncKind', event.target.value)}
              >
                <option value="session">One session</option>
                <option value="event">One event</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="recovery-sync-id">Exact selected UUID</label>
              <input
                id="recovery-sync-id"
                value={input.syncId}
                onChange={(event) => change('syncId', event.target.value)}
                placeholder="Copy the selected sessionId or eventId"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="recovery-sync-help"
                aria-invalid={shown && Boolean(input.syncId) && Boolean(commands.errors.syncId)}
              />
              {shown && input.syncId && commands.errors.syncId && (
                <p className="form-error">{commands.errors.syncId}</p>
              )}
            </div>
          </div>
          <p id="recovery-sync-help" className={styles.help}>
            Leave empty to generate only the offline listing. Selected sync requires the original
            binding and an authorized running API.
          </p>
        </fieldset>
        <button type="submit" className="button button-primary">
          Show manual commands
        </button>
      </form>
      {shown && (
        <div className={styles.results}>
          <h3>1. Inspect the local outbox</h3>
          {commands.listCommand ? (
            <div id="memvora-outbox-list-command">
              <CopyCommand command={commands.listCommand} />
            </div>
          ) : (
            <p className="form-error" role="status">
              Correct the folder and listing fields to generate the read-only command.
            </p>
          )}
          <h3>2. Sync only the selected evidence</h3>
          {!syncPrefix ? (
            <p className="form-error">
              Selected sync is unavailable until local API configuration is corrected.
            </p>
          ) : commands.syncCommand ? (
            <div id="memvora-outbox-sync-command">
              <CopyCommand command={commands.syncCommand} />
            </div>
          ) : (
            <p className={styles.help}>
              Enter a valid selected UUID to generate an upload command. The read-only list does not
              require one.
            </p>
          )}
          {commands.syncCommand && (
            <p className={styles.help}>
              This command enters the capture folder, runs the selection, then returns to your
              previous location. It is separate from the list’s state, session filter and
              pagination.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
