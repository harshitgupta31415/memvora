import Link from 'next/link';
import { GitHubStatusSchema, MeSchema, SettingsSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { localDoctorCommand } from '@/lib/local-setup';
import { Icon } from '@/components/icon';
import { ErrorState, PageHeading } from '@/components/ui';
import { CopyCommand, RefreshButton } from '@/components/controls';
import { GitHubConnection } from '@/components/github-connection';

export const dynamic = 'force-dynamic';

function bytes(value: number) {
  return value >= 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MiB`
    : `${Math.round(value / 1024)} KiB`;
}

export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const outcome =
    parameters.github === 'connected' ||
    parameters.github === 'denied' ||
    parameters.github === 'failed'
      ? parameters.github
      : undefined;
  const [settings, me, github] = await Promise.all([
    apiRequest('/v1/settings', SettingsSchema),
    apiRequest('/v1/me', MeSchema),
    apiRequest('/v1/github/status', GitHubStatusSchema),
  ]);
  return (
    <>
      <PageHeading
        eyebrow="LOCAL CONFIGURATION"
        title="Workspace settings"
        description="Understand how this workspace stores evidence, processes memories, and connects to other tools."
        action={<RefreshButton />}
      />
      {github.ok ? (
        <GitHubConnection status={github.data} {...(outcome ? { outcome } : {})} />
      ) : (
        <ErrorState message={`GitHub connection status is unavailable. ${github.message}`} />
      )}
      {!settings.ok ? (
        <ErrorState message={settings.message} />
      ) : (
        <div className="settings-grid section-top">
          <section className="panel settings-panel">
            <h2>
              <Icon name="grid" size={17} />
              Workspace
            </h2>
            <ul className="provenance">
              <li>
                <span>Mode</span>
                <span>Local, single user</span>
              </li>
              <li>
                <span>Name</span>
                <span>{me.ok ? me.data.workspace.name : 'Unavailable'}</span>
              </li>
              <li>
                <span>Owner</span>
                <span>{me.ok ? me.data.user.name : 'Unavailable'}</span>
              </li>
              <li>
                <span>Generation</span>
                <span>{me.ok ? me.data.workspace.generation : 'Unavailable'}</span>
              </li>
            </ul>
            <p className="settings-help">
              This local identity is for development. It is not a production sign-in or an
              organization access policy.
            </p>
          </section>
          <section className="panel settings-panel">
            <h2>
              <Icon name="repo" size={17} />
              Evidence storage
            </h2>
            <ul className="provenance">
              <li>
                <span>Adapter</span>
                <span>{settings.data.storage.adapter}</span>
              </li>
              <li>
                <span>Database</span>
                <span className="mono">{settings.data.storage.path}</span>
              </li>
              <li>
                <span>Credentials</span>
                <span>Server-side local token</span>
              </li>
            </ul>
            <p className="settings-help">
              The browser never receives the workspace token. Captured evidence is stored locally;
              keep the data directory private.
            </p>
            <Link href="/backups" className="inline-link">
              Create and verify a manual backup <Icon name="arrow" size={13} />
            </Link>
            <p className="settings-help">
              <Link href="/capture-recovery" className="inline-link">
                Inspect and selectively sync local capture <Icon name="arrow" size={13} />
              </Link>
            </p>
          </section>
          <section className="panel settings-panel">
            <h2>
              <Icon name="spark" size={17} />
              Memory processing
            </h2>
            <ul className="provenance">
              <li>
                <span>Mode</span>
                <span>{settings.data.enrichment.mode}</span>
              </li>
              <li>
                <span>Status</span>
                <span>{settings.data.enrichment.status}</span>
              </li>
              <li>
                <span>Behavior</span>
                <span>{settings.data.enrichment.label}</span>
              </li>
              <li>
                <span>AI integration</span>
                <span>{settings.data.configuration.ai}</span>
              </li>
            </ul>
            <p className="settings-help">
              Observed summaries describe captured attempts and outcomes. Any configured AI
              processing must remain grounded in the same evidence.
            </p>
          </section>
          <section className="panel settings-panel">
            <h2>
              <Icon name="code" size={17} />
              Capture and request limits
            </h2>
            <ul className="provenance">
              <li>
                <span>Events per batch</span>
                <span>{settings.data.limits.batchEvents}</span>
              </li>
              <li>
                <span>Batch size</span>
                <span>{bytes(settings.data.limits.batchBytes)}</span>
              </li>
              <li>
                <span>Event size</span>
                <span>{bytes(settings.data.limits.eventBytes)}</span>
              </li>
              <li>
                <span>Command output</span>
                <span>{bytes(settings.data.limits.outputBytes)}</span>
              </li>
            </ul>
            <p className="settings-help">
              Truncation and incomplete capture are shown with the original event. Limits do not
              imply that every secret can be detected.
            </p>
          </section>
          <section className="panel settings-panel settings-wide">
            <h2>
              <Icon name="link" size={17} />
              Connections and diagnostics
            </h2>
            <ul className="provenance">
              <li>
                <span>GitHub</span>
                <span>{settings.data.configuration.github}</span>
              </li>
              <li>
                <span>MCP</span>
                <span>Local stdio adapter over the same evidence API</span>
              </li>
            </ul>
            <CopyCommand command={localDoctorCommand()} />
            <p className="settings-help">
              Diagnostics use this terminal’s environment and the root configuration file.
              Credentials are managed outside the browser.
            </p>
            <Link href="/setup" className="inline-link">
              Set up the CLI and read-only MCP <Icon name="arrow" size={13} />
            </Link>
          </section>
        </div>
      )}
    </>
  );
}
