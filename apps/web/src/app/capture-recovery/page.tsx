import Link from 'next/link';
import { headers } from 'next/headers';
import { trustedLocalHost } from '@/lib/api';
import { localCaptureRecoveryDetails } from '@/lib/local-setup';
import { CaptureRecoveryBuilder } from '@/components/capture-recovery-builder';
import { Icon } from '@/components/icon';
import { ErrorState, PageHeading, SectionHeading } from '@/components/ui';
import styles from './recovery.module.css';

export const dynamic = 'force-dynamic';

export default async function CaptureRecovery({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const heading = (
    <PageHeading
      eyebrow="LOCAL CAPTURE RECOVERY"
      title="Inspect first. Sync a deliberate selection."
      description="Build manual PowerShell commands for a repository’s local capture outbox. Generating instructions does not inspect files or upload evidence."
    />
  );
  if (Object.keys(parameters).length > 0)
    return (
      <>
        {heading}
        <ErrorState
          message="This capture-recovery link is invalid."
          detail="This guide takes no query parameters. No capture commands were generated."
        />
        <Link href="/capture-recovery" className="button button-small">
          Open the recovery guide
        </Link>
      </>
    );
  if (!trustedLocalHost((await headers()).get('host')))
    return (
      <>
        {heading}
        <ErrorState
          message="Capture recovery requires a loopback address."
          detail="Open the website through 127.0.0.1 or localhost on this machine."
        />
      </>
    );
  const details = await localCaptureRecoveryDetails();
  return (
    <>
      <Link href="/setup" className="back-link">
        <Icon name="arrow" size={13} />
        Local setup
      </Link>
      {heading}
      <section className={`panel ${styles.section}`}>
        <SectionHeading title="Before choosing evidence" />
        <p>
          The capture folder contains <code>.memvora/config.json</code> and{' '}
          <code>.memvora/outbox.sqlite</code>. This is separate from the server’s evidence database.
          Build the compiled CLI first; its entry file is{' '}
          {details.cliBuilt ? 'present on this machine' : 'missing and needs a build'}. File
          presence alone does not verify the build.
        </p>
        <p>
          Offline listing requires no token or running API. It opens an existing outbox logically
          read-only, without initialization, migration, crash recovery or acknowledgement changes.
          SQLite may manage locking sidecars. This website does not open the outbox.
        </p>
        {details.syncConfigurationError && (
          <p className={styles.warning}>
            {details.syncConfigurationError} Offline list commands remain available.
          </p>
        )}
        {details.externalCredential && (
          <p className={styles.warning}>
            Selected upload uses the same server credential as this workspace. If supplied through{' '}
            <code>MEMVORA_LOCAL_TOKEN</code>, provide it privately to the terminal or root
            environment file. Its value is not in these instructions.
          </p>
        )}
      </section>
      <CaptureRecoveryBuilder listPrefix={details.listPrefix} syncPrefix={details.syncPrefix} />
      <div className={styles.guide}>
        <section className={`panel ${styles.section}`}>
          <SectionHeading title="Read the local states honestly" />
          <dl className={styles.states}>
            <div>
              <dt>Unsynced</dt>
              <dd>
                Pending finalized events plus unfinished captures. This is the default selection.
              </dd>
            </div>
            <div>
              <dt>Pending</dt>
              <dd>
                A finalized local event without a durable acknowledgement recorded in this outbox.
              </dd>
            </div>
            <div>
              <dt>Incomplete</dt>
              <dd>
                An unfinished local execution. It can still be running; it is not proof that its
                owner crashed.
              </dd>
            </div>
            <div>
              <dt>Synced</dt>
              <dd>
                An exact API acknowledgement was recorded locally. Later server deletion or access
                changes can still make it unavailable.
              </dd>
            </div>
          </dl>
          <p>
            Results contain bounded metadata, not command output or diff payloads. Read{' '}
            <code>exists</code>, the effective filter, totals and <code>page.nextAfter</code>.
            Totals cover the selected session before state and page limits. Pages are live and
            ordered by local row ID; keep the same filters when using the next row ID. A missing
            outbox is not created.
          </p>
        </section>
        <section className={`panel ${styles.section}`}>
          <SectionHeading title="Upload one session or event after inspection" />
          <p>
            An older rejected event can block a mixed unfiltered sync batch. A session or event
            selection narrows which finalized events are attempted. Use one selector only, retain
            the original capture binding, and connect to its authorized local API.
          </p>
          <p>
            Selected sync does not finalize unfinished captures. It reports remaining pending and
            incomplete rows. Its start-row boundary leaves later captures pending; finalization of
            an existing row can still change what is eligible during the operation. Check the
            acknowledged count, selected remaining counts, total remaining counts and stop reason.
          </p>
          <p className={styles.warning}>
            A selected upload does not restore a deleted repository, session or event, bypass
            authorization, or repair a rejected payload. Preserve event IDs and content. Do not
            delete the outbox, reassign rows, edit sent evidence or force acknowledgements.
          </p>
          <p>
            Ordinary unfiltered sync retains conservative confirmed-dead capture recovery. Listing
            and selected sync leave incomplete executions unchanged. If a process is live,
            inaccessible or has an ambiguous reused identity, keep its evidence for review.
          </p>
        </section>
        <section className={`panel ${styles.section}`}>
          <SectionHeading title="Preserve the private original" />
          <p>
            The raw outbox can contain sensitive code and terminal evidence. Keep it outside Git and
            restrict access to your Windows account. A server backup excludes these local bindings
            and outboxes, so retain them separately when they contain unsynced work. Server deletion
            does not remove independent local copies.
          </p>
          <p>
            The command builder saves nothing and performs no upload. Run a copied command only
            after checking its folder and UUIDs in PowerShell. Inspect the next local listing and
            the original investigation after any selected sync; a successful test exit or local
            acknowledgement does not establish that an issue was fixed.
          </p>
          <div className={styles.links}>
            <Link href="/setup" className="inline-link">
              Local tool setup <Icon name="arrow" size={13} />
            </Link>
            <Link href="/backups" className="inline-link">
              Server backup guide <Icon name="arrow" size={13} />
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
