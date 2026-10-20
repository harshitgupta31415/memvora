import { MeSchema, SettingsSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import { ErrorState, PageHeading } from '@/components/ui';
import { CopyCommand, RefreshButton } from '@/components/controls';

export const dynamic = 'force-dynamic';

function bytes(value: number) {
  return value >= 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MiB`
    : `${Math.round(value / 1024)} KiB`;
}

export default async function Settings() {
  const [settings, me] = await Promise.all([
    apiRequest('/v1/settings', SettingsSchema),
    apiRequest('/v1/me', MeSchema),
  ]);
  return (
    <>
      <PageHeading
        eyebrow="LOCAL CONFIGURATION"
        title="Workspace settings"
        description="Understand how this workspace stores evidence, processes memories, and connects to other tools."
        action={<RefreshButton />}
      />
      {!settings.ok ? (
        <ErrorState message={settings.message} />
      ) : (
        <div className="settings-grid">
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
            <CopyCommand command="npm run doctor" />
            <p className="settings-help">
              Run diagnostics from the project root. For supported configuration and setup, use the
              maintained project README. Credentials are managed outside the browser.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
