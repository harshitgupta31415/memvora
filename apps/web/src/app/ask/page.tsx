import Link from 'next/link';
import { Compile } from 'typebox/compile';
import {
  IdSchema,
  RepositoryListSchema,
  RepositoryResponseSchema,
  SettingsSchema,
} from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import { AskForm } from '@/components/ask-form';
import { ErrorState, PageHeading } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Ask({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const requestedRepository = parameters.repositoryId;
  const requestedQuery = parameters.query;
  if (
    (requestedRepository !== undefined &&
      (typeof requestedRepository !== 'string' || !Compile(IdSchema).Check(requestedRepository))) ||
    (requestedQuery !== undefined &&
      (typeof requestedQuery !== 'string' || requestedQuery.length > 2000))
  )
    return (
      <>
        <PageHeading
          title="Ask Memvora"
          description="Choose a valid repository and question to begin source-linked recall."
        />
        <ErrorState
          message="The recall link contains an invalid repository or question."
          detail="No question was submitted. Open Ask to choose the scope explicitly."
        />
        <Link href="/ask" className="inline-link section-top">
          Open Ask <Icon name="arrow" size={12} />
        </Link>
      </>
    );
  const [repositories, settings] = await Promise.all([
    apiRequest('/v1/repositories', RepositoryListSchema),
    apiRequest('/v1/settings', SettingsSchema),
  ]);
  let availableRepositories = repositories.ok ? repositories.data.items : [];
  if (
    typeof requestedRepository === 'string' &&
    !availableRepositories.some((repository) => repository.id === requestedRepository)
  ) {
    const selected = await apiRequest(
      `/v1/repositories/${encodeURIComponent(requestedRepository)}`,
      RepositoryResponseSchema,
    );
    if (!selected.ok)
      return (
        <>
          <PageHeading
            title="Ask Memvora"
            description="Recover evidence within the repository you selected."
          />
          <ErrorState
            message={selected.message}
            detail="The requested repository could not be opened. No question was submitted with a wider scope."
          />
          <Link href="/ask" className="inline-link section-top">
            Choose another scope <Icon name="arrow" size={12} />
          </Link>
        </>
      );
    availableRepositories = [...availableRepositories, selected.data.repository];
  }
  return (
    <>
      <PageHeading
        eyebrow="SOURCE-LINKED RECALL"
        title="Ask Memvora"
        description="Recover earlier investigations and locate evidence in the current imported code snapshot."
      />
      {!repositories.ok ? (
        <ErrorState message={repositories.message} />
      ) : (
        <div className="ask-layout">
          <AskForm
            key={`${requestedRepository ?? ''}:${requestedQuery ?? ''}`}
            repositories={availableRepositories}
            initialRepositoryId={typeof requestedRepository === 'string' ? requestedRepository : ''}
            initialQuery={typeof requestedQuery === 'string' ? requestedQuery : ''}
          />
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
                <span>Imported code with commit, content hash, and stored snapshot lines</span>
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
