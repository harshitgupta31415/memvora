import Link from 'next/link';
import { headers } from 'next/headers';
import { MeSchema, RepositoryResponseSchema } from '@memvora/contracts';
import { apiRequest, trustedLocalHost } from '@/lib/api';
import { localDoctorCommand, localSetupDetails } from '@/lib/local-setup';
import { parseSetupQuery } from '@/lib/setup-commands';
import { CopyCommand, RefreshButton } from '@/components/controls';
import { CopyText } from '@/components/copy-text';
import { Icon } from '@/components/icon';
import { ErrorState, PageHeading, SectionHeading } from '@/components/ui';
import styles from './setup.module.css';

export const dynamic = 'force-dynamic';

export default async function LocalSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseSetupQuery(await searchParams);
  const heading = (
    <PageHeading
      eyebrow="LOCAL SETUP"
      title="Connect your work to Memvora."
      description="Build the local tools, capture from your actual repository, and let your assistant read the same evidence. Windows PowerShell instructions."
      action={<RefreshButton />}
    />
  );
  if (!query.ok)
    return (
      <>
        {heading}
        <ErrorState
          message="This setup link is invalid."
          detail="Use no query parameters, or one valid repositoryId. No setup commands were generated."
        />
        <Link href="/setup" className="button button-small">
          Open local setup
        </Link>
      </>
    );
  if (!trustedLocalHost((await headers()).get('host')))
    return (
      <>
        {heading}
        <ErrorState
          message="Local setup requires a loopback address."
          detail="Open this website through 127.0.0.1 or localhost on the machine running Memvora."
        />
      </>
    );

  const [me, repository] = await Promise.all([
    apiRequest('/v1/me', MeSchema),
    query.repositoryId
      ? apiRequest(
          `/v1/repositories/${encodeURIComponent(query.repositoryId)}`,
          RepositoryResponseSchema,
        )
      : Promise.resolve(null),
  ]);
  if (repository && (!repository.ok || repository.data.repository.id !== query.repositoryId))
    return (
      <>
        {heading}
        <ErrorState
          message="This repository is unavailable for setup."
          detail={
            repository.ok
              ? 'The repository response did not match this setup link. No binding commands were generated.'
              : `${repository.message} No binding commands were generated.`
          }
        />
        <Link href="/repositories" className="button button-small">
          Choose an available repository
        </Link>
      </>
    );

  const details = await localSetupDetails();
  if (!details.ok)
    return (
      <>
        {heading}
        <ErrorState message="Local tool configuration is invalid." detail={details.message} />
      </>
    );
  const selected = repository?.ok ? repository.data.repository : null;
  const init = selected ? ['init', '--repository-id', selected.id] : ['init'];
  const ask = [
    'ask',
    'What happened when I ran the tests?',
    ...(selected ? ['--repository', selected.id] : []),
  ];
  const findSessionsInput = JSON.stringify(
    { ...(selected ? { repositoryId: selected.id } : {}), limit: 5 },
    null,
    2,
  );

  return (
    <>
      {heading}
      <section className={`panel ${styles.status}`} aria-labelledby="setup-status">
        <SectionHeading title="What is ready on this machine" action={<RefreshButton />} />
        <h3 id="setup-status" className="sr-only">
          Current setup status
        </h3>
        <dl className={styles.checks}>
          <div>
            <dt>CLI compiled entry</dt>
            <dd className={details.cliBuilt ? styles.ready : styles.missing}>
              {details.cliBuilt ? 'File present' : 'Build required'}
            </dd>
          </div>
          <div>
            <dt>MCP compiled entry</dt>
            <dd className={details.mcpBuilt ? styles.ready : styles.missing}>
              {details.mcpBuilt ? 'File present' : 'Build required'}
            </dd>
          </div>
          <div>
            <dt>Authenticated local API</dt>
            <dd className={me.ok ? styles.ready : styles.missing}>
              {me.ok ? 'Connected' : 'Unavailable'}
            </dd>
          </div>
        </dl>
        <p className={styles.help}>
          {me.ok
            ? `${me.data.user.name} · ${me.data.workspace.name}. This is a trusted-machine personal workspace.`
            : `${me.message} Start the local API and refresh to check the connection.`}{' '}
          File presence does not verify a current build or an MCP host connection.
        </p>
        {selected && (
          <p className={styles.scope}>
            Binding target: <Link href={`/repositories/${selected.id}`}>{selected.name}</Link>
            <code>{selected.id}</code>
          </p>
        )}
        {details.externalCredential && (
          <p className={styles.credentialNotice}>
            This web process receives a credential through <code>MEMVORA_LOCAL_TOKEN</code>. Supply
            the same secret through your terminal and MCP host’s private environment, or a protected
            root <code>.env</code>. It is intentionally absent from these commands and
            configuration. Do not paste it into chat or commit it.
          </p>
        )}
      </section>

      <div className={styles.guide}>
        <section className={`panel ${styles.step}`} aria-labelledby="setup-build">
          <span className={styles.number}>01</span>
          <div className={styles.content}>
            <h2 id="setup-build">Build once from the Memvora folder</h2>
            <p>
              Use Node.js 24 or 26 and npm 11+. Git adds revision and diff context. In your first
              PowerShell terminal, switch to the Memvora application folder. Stop Memvora processes
              before rebuilding; rebuild after changes to the tools.
            </p>
            <CopyCommand command={details.changeDirectory} />
            <details className={styles.details}>
              <summary>First checkout, or dependencies missing?</summary>
              <p>Install the locked dependencies from this same folder before building.</p>
              <CopyCommand command={details.install} />
            </details>
            <CopyCommand command={details.build} />
            <p>The resource wrapper keeps the build within this machine’s configured CPU limits.</p>
            <h3>Start the compiled website and API</h3>
            <CopyCommand command={details.start} />
            <p>
              Keep this terminal running. If the local app is already running, skip this start
              command. The default website is <code>http://127.0.0.1:3000</code>; the API uses port
              4000. A separate worker is not required for the default local flow.
            </p>
          </div>
        </section>

        <section className={`panel ${styles.step}`} aria-labelledby="setup-bind">
          <span className={styles.number}>02</span>
          <div className={styles.content}>
            <h2 id="setup-bind">Open your actual repository in a second terminal</h2>
            <p>
              Open PowerShell inside the codebase you want to capture. This can be a different
              folder from Memvora. The absolute commands below find Memvora without changing your
              working directory. Check your current location first.
            </p>
            <CopyCommand command="Get-Location" />
            <CopyCommand command={details.cliCommand(['status'])} />
            <h3>{selected ? 'Bind this authorized repository' : 'Initialize the target folder'}</h3>
            <CopyCommand command={details.cliCommand(init)} />
            <p>
              A first initialization creates a local binding and an initial investigation. A
              matching valid binding is reused, preserving its current investigation. A different
              existing repository or API binding is refused; initialization does not silently switch
              it. Keep <code>.memvora</code> private and excluded from Git.
            </p>
            <CopyCommand command={details.cliCommand(['status'])} />
            <p>Confirm the returned repository and investigation before recording commands.</p>
          </div>
        </section>

        <section className={`panel ${styles.step}`} aria-labelledby="setup-capture">
          <span className={styles.number}>03</span>
          <div className={styles.content}>
            <h2 id="setup-capture">Capture one real attempt</h2>
            <p>
              Use the initial investigation for your first capture. For a separate investigation,
              start one deliberately with a descriptive title. Starting another investigation
              selects it for subsequent commands; it does not verify or resolve the previous one.
            </p>
            <details className={styles.details}>
              <summary>Start a separate investigation, or continue after ending one</summary>
              <CopyCommand
                command={details.cliCommand(['session', 'start', 'Investigate failing tests'])}
              />
              <p>
                A reused binding also preserves a closed current investigation. Start a new one when
                you want a separate grouping.
              </p>
            </details>
            <h3>Run a command explicitly through Memvora</h3>
            <CopyCommand command={details.cliCommand(['run', '--', 'npm', 'test'])} />
            <p>
              This example runs your target repository’s test script. Use it only if that project
              defines one, or replace <code>npm test</code> with the command you intend to run.
              Successful and failed exits are both evidence. Commands run outside this wrapper are
              not monitored. Review captured output for private information; redaction has limits.
            </p>
            <h3>Upload pending evidence, then end the investigation</h3>
            <CopyCommand command={details.cliCommand(['sync'])} />
            <CopyCommand command={details.cliCommand(['session', 'end'])} />
            <p>
              Capture attempts an upload. Sync retries the local outbox when needed. Ending an
              investigation closes its grouping; it does not claim that an issue was fixed.
            </p>
            <CopyCommand command={details.cliCommand(ask)} />
            <div className={styles.links}>
              <Link
                href={selected ? `/sessions?repositoryId=${selected.id}` : '/sessions'}
                className="inline-link"
              >
                Open investigations <Icon name="arrow" size={13} />
              </Link>
              <Link
                href={selected ? `/ask?repositoryId=${selected.id}` : '/ask'}
                className="inline-link"
              >
                Ask in the website <Icon name="arrow" size={13} />
              </Link>
            </div>
          </div>
        </section>

        <section className={`panel ${styles.step}`} aria-labelledby="setup-mcp">
          <span className={styles.number}>04</span>
          <div className={styles.content}>
            <h2 id="setup-mcp">Connect a read-only MCP client</h2>
            <p>
              Add this server entry to a client that supports local stdio MCP servers. Merge the
              entry into an existing <code>mcpServers</code> object instead of replacing other
              servers. Client configuration formats can differ; use its supported local-server
              settings. These paths belong to this machine.
            </p>
            <CopyText text={details.mcpConfiguration} label="Copy MCP configuration" />
            <pre id="memvora-mcp-configuration" className={styles.configuration}>
              {details.mcpConfiguration}
            </pre>
            <p>
              The arguments load the root <code>.env</code> only if it exists. No token value is
              included in this configuration. The API origin and data directory preserve this
              website’s current non-secret settings. The tools require the same running API and
              credential; restart after configuration changes.
            </p>
            <h3>Restart the MCP host, then verify</h3>
            <ol className={styles.verify}>
              <li>Confirm that its Memvora server starts successfully.</li>
              <li>
                Ask it to call <code>memvora_status</code> with <code>{'{}'}</code>.
              </li>
              <li>
                Ask it to call <code>find_sessions</code> with the input below, then compare
                returned investigation IDs with the website. An empty result is valid before you
                create one.
              </li>
            </ol>
            <pre className={styles.configuration}>{findSessionsInput}</pre>
            <p>
              These tools retrieve authorized stored evidence. They do not capture terminal work,
              execute recorded commands, or prove that a reported resolution is correct.
            </p>
          </div>
        </section>

        <section className={`panel ${styles.step}`} aria-labelledby="setup-diagnostics">
          <span className={styles.number}>
            <Icon name="settings" size={15} />
          </span>
          <div className={styles.content}>
            <h2 id="setup-diagnostics">If something is unavailable</h2>
            <CopyCommand command={localDoctorCommand()} />
            <p>
              Diagnostics report local prerequisites without printing credentials. If a compiled
              entry is missing, return to the build step. If API access fails, start the API, verify
              its local credential and matching configuration, then refresh this page. After ending
              an investigation, start a separate one before capturing more work.
            </p>
            <Link href="/settings" className="inline-link">
              Review workspace settings <Icon name="arrow" size={13} />
            </Link>
            <div className={styles.links}>
              <Link href="/backups" className="inline-link">
                Back up and verify local evidence <Icon name="arrow" size={13} />
              </Link>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
