import { RepositoryListSchema, SettingsSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import { AskForm } from '@/components/ask-form';
import { ErrorState, PageHeading } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Ask() {
  const [repositories, settings] = await Promise.all([
    apiRequest('/v1/repositories', RepositoryListSchema),
    apiRequest('/v1/settings', SettingsSchema),
  ]);
  return (
    <>
      <PageHeading
        eyebrow="SOURCE-LINKED RECALL"
        title="Ask Memvora"
        description="Recover the investigation behind an earlier problem. Start from what was actually recorded."
      />
      {!repositories.ok ? (
        <ErrorState message={repositories.message} />
      ) : (
        <div className="ask-layout">
          <AskForm repositories={repositories.data.items} />
          <aside className="ask-sidebar">
            <section className="panel">
              <h3>Context you can inspect.</h3>
              <p>
                Memvora retrieves the evidence in this workspace, then connects its observations
                into a source-linked answer.
              </p>
              <div className="capability-item">
                <Icon name="check" size={13} />
                <span>Original commands and outcomes</span>
              </div>
              <div className="capability-item">
                <Icon name="check" size={13} />
                <span>Recorded conditions and changes</span>
              </div>
              <div className="capability-item">
                <Icon name="check" size={13} />
                <span>Sources you can open and verify</span>
              </div>
              <div className="capability-item">
                <Icon name="check" size={13} />
                <span>Uncertainty when evidence is missing</span>
              </div>
              <p className="muted-caption">
                {settings.ok
                  ? settings.data.enrichment.label
                  : 'The response identifies its recall mode.'}
              </p>
            </section>
            <div className="notice notice-neutral section-top">
              <Icon name="terminal" size={17} />
              <div>
                <strong>Read-only by design.</strong>
                <p>Recall never runs a command or applies an earlier fix to your code.</p>
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
