import Link from 'next/link';
import { headers } from 'next/headers';
import { trustedLocalHost } from '@/lib/api';
import { localBackupDetails } from '@/lib/local-setup';
import { CopyCommand, RefreshButton } from '@/components/controls';
import { Icon } from '@/components/icon';
import { ErrorState, PageHeading, SectionHeading } from '@/components/ui';
import styles from './backups.module.css';

export const dynamic = 'force-dynamic';

export default async function Backups({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const heading = (
    <PageHeading
      eyebrow="LOCAL BACKUP GUIDE"
      title="Keep a verified copy of your evidence."
      description="Create and verify a local database snapshot manually in Windows PowerShell. These instructions do not run a backup in your browser."
      action={<RefreshButton />}
    />
  );
  if (Object.keys(parameters).length > 0)
    return (
      <>
        {heading}
        <ErrorState
          message="This backup guide link is invalid."
          detail="This page accepts no query parameters. No backup commands were generated."
        />
        <Link href="/backups" className="button button-small">
          Open the backup guide
        </Link>
      </>
    );
  if (!trustedLocalHost((await headers()).get('host')))
    return (
      <>
        {heading}
        <ErrorState
          message="Local backup guidance requires a loopback address."
          detail="Open this website through 127.0.0.1 or localhost on the machine running Memvora."
        />
      </>
    );
  const details = await localBackupDetails();
  if (!details.ok)
    return (
      <>
        {heading}
        <ErrorState message="Local tool configuration is invalid." detail={details.message} />
      </>
    );

  const ready = details.scriptPresent && details.databaseBuilt && details.sourcePresent;
  return (
    <>
      <Link href="/settings" className="back-link">
        <Icon name="arrow" size={13} />
        Workspace settings
      </Link>
      {heading}
      <section className={`panel ${styles.overview}`} aria-labelledby="backup-prerequisites">
        <SectionHeading title="Local prerequisites" />
        <h2 id="backup-prerequisites" className="sr-only">
          Current file checks
        </h2>
        <dl className={styles.checks}>
          <div>
            <dt>Backup operator script</dt>
            <dd className={details.scriptPresent ? styles.ready : styles.missing}>
              {details.scriptPresent ? 'File present' : 'Missing'}
            </dd>
          </div>
          <div>
            <dt>Compiled backup utility</dt>
            <dd className={details.databaseBuilt ? styles.ready : styles.missing}>
              {details.databaseBuilt ? 'File present' : 'Build required'}
            </dd>
          </div>
          <div>
            <dt>Source server.sqlite</dt>
            <dd className={details.sourcePresent ? styles.ready : styles.missing}>
              {details.sourcePresent ? 'File present' : 'Not found'}
            </dd>
          </div>
        </dl>
        <p className={styles.help}>
          These checks establish file presence only. A successful create and verify command is
          required to validate a snapshot. This guide does not load database records or inspect
          previous backups.
        </p>
        <div className={styles.source}>
          <span>Configured source database</span>
          <code>{details.source}</code>
        </div>
        {!ready && (
          <p className={styles.missingHelp}>
            Resolve missing prerequisites first. Build the tools from the local setup guide. If the
            source database is missing, confirm the configured data directory and start the local
            API once to create it. Do not substitute an unrelated database.
          </p>
        )}
      </section>

      <div className={styles.guide}>
        <section className={`panel ${styles.section}`} aria-labelledby="backup-coverage">
          <SectionHeading
            title="What this copy contains"
            description="A full SQLite snapshot for this local Memvora instance."
          />
          <h2 id="backup-coverage" className="sr-only">
            Backup coverage and privacy
          </h2>
          <div className={styles.coverage}>
            <div>
              <h3>Included</h3>
              <p>
                Stored repositories, investigations, commands, authored notes, imported source
                snapshots, memories and processing state. The database also retains its encrypted
                GitHub connection records and cursor-signing state.
              </p>
            </div>
            <div>
              <h3>Keep separately</h3>
              <p>
                The external local-token credential, <code>.env</code> files, each target
                repository’s capture binding and outbox, and your working codebase. Pending unsynced
                capture is not in the server database.
              </p>
            </div>
          </div>
          <p className={styles.warning}>
            The raw database snapshot is sensitive and is not encrypted as a whole. Existing
            encrypted OAuth fields remain encrypted; command output, source code and other records
            can contain private data. On Windows, files inherit the destination folder’s access
            controls. File mode settings do not guarantee private Windows ACLs. Use a directory
            restricted to your Windows account and inspect its permissions.
          </p>
        </section>

        <section className={`panel ${styles.section}`} aria-labelledby="backup-create">
          <SectionHeading title="1. Create a fresh snapshot" />
          <h2 id="backup-create" className="sr-only">
            Create command
          </h2>
          <p>
            Run this in PowerShell on this machine. The utility reads the configured source database
            and creates a consistent online SQLite snapshot, so the local API can stay running. It
            does not copy a live database file by hand or change source records.
          </p>
          <div id="memvora-backup-create">
            <CopyCommand command={details.commands.create} />
          </div>
          <p>The destination is a newly created timestamp-and-UUID directory under:</p>
          <code className={styles.path}>{details.defaultDestination}</code>
          <p>
            Keep this PowerShell session open. The command stores the returned directory in
            <code> $memvoraBackup</code> for verification. It creates <code>server.sqlite</code>
            and <code>manifest.json</code>, adds a nested <code>.gitignore</code>, and refuses an
            existing output directory.
          </p>
          <details className={styles.details}>
            <summary>Choose another destination</summary>
            <p>
              Add <code>--output</code> followed by a new absolute directory to the create
              invocation, before the <code>| ConvertFrom-Json</code> pipe. Quote that path as a
              PowerShell single-quoted literal, doubling any apostrophe. Choose a private parent
              directory; the utility will not overwrite an existing backup.
            </p>
          </details>
          <p className={styles.help}>
            Commands use the resource wrapper with at most two logical processors on Windows. Only
            paths are shown here; credentials are not included or uploaded.
          </p>
        </section>

        <section className={`panel ${styles.section}`} aria-labelledby="backup-verify">
          <SectionHeading title="2. Verify that exact snapshot" />
          <h2 id="backup-verify" className="sr-only">
            Verify command
          </h2>
          <p>
            In the same PowerShell session, run the command below. It checks the snapshot selected
            by the completed create command, rather than guessing the newest folder.
          </p>
          <div id="memvora-backup-verify">
            <CopyCommand command={details.commands.verify} />
          </div>
          <p>
            Verification checks the manifest’s SHA-256, supported database schema, SQLite integrity,
            foreign keys and instance metadata. Read the returned JSON and require a successful
            exit. If verification fails, retain the original database and review the terminal error.
            A passed check verifies this copy; it does not prove a live restore has been tested.
          </p>
        </section>

        <section className={`panel ${styles.section}`} aria-labelledby="backup-retain">
          <SectionHeading title="3. Retain it deliberately" />
          <h2 id="backup-retain" className="sr-only">
            Retention and recovery limits
          </h2>
          <p>
            A manual copy on the same disk does not protect against disk loss. Move a verified copy
            to storage you control with suitable encryption and access permissions. Preserve its
            manifest, and retain necessary credentials and local outboxes separately. Nothing is
            sent to remote storage by this guide or utility.
          </p>
          <p>
            Saved backups keep the data they contain after later deletion or disconnect in the
            running application. Protect or remove those independent copies according to your
            retention needs. This is a manual same-instance backup workflow, not cross-device
            synchronization.
          </p>
          <p className={styles.warning}>
            Live restore is not available in the website or operator command. Do not replace the
            running database with a copied file. Use disposable test data for any restore rehearsal.
          </p>
          <div className={styles.links}>
            <Link href="/setup" className="inline-link">
              Review local setup <Icon name="arrow" size={13} />
            </Link>
            <Link href="/settings" className="inline-link">
              Workspace settings <Icon name="arrow" size={13} />
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
