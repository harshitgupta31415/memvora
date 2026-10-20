import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  RepositoryContextResponseSchema,
  RepositoryListSchema,
  SessionListSchema,
} from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import { DateLabel, EmptyState, ErrorState, PageHeading, SectionHeading } from '@/components/ui';
import { SessionRow } from '@/components/evidence';
import { CopyCommand, RefreshButton } from '@/components/controls';

export const dynamic = 'force-dynamic';

export default async function RepositoryDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [repositories, context, sessions] = await Promise.all([
    apiRequest('/v1/repositories', RepositoryListSchema),
    apiRequest(
      `/v1/repositories/${encodeURIComponent(id)}/context`,
      RepositoryContextResponseSchema,
    ),
    apiRequest('/v1/sessions', SessionListSchema),
  ]);
  if (!repositories.ok) return <ErrorState message={repositories.message} />;
  const repository = repositories.data.items.find((repo) => repo.id === id);
  if (!repository) notFound();
  const imported = context.ok ? context.data.context : null;
  const investigations = sessions.ok
    ? sessions.data.items.filter((session) => session.repositoryId === id)
    : [];
  return (
    <>
      <Link href="/repositories" className="back-link">
        <Icon name="arrow" size={13} />
        All repositories
      </Link>
      <PageHeading
        eyebrow="REPOSITORY CONTEXT"
        title={repository.name}
        description={
          repository.localPath ?? repository.remoteUrl ?? 'A project in your personal workspace.'
        }
        action={<RefreshButton />}
      />
      <div className="two-column">
        <div className="content-stack">
          <section className="panel section-padding">
            <SectionHeading
              title="Investigations in this project"
              action={
                <Link href={`/sessions?repositoryId=${id}`} className="inline-link">
                  View all <Icon name="arrow" size={12} />
                </Link>
              }
            />
            {!sessions.ok ? (
              <ErrorState message={sessions.message} />
            ) : investigations.length ? (
              investigations
                .slice(0, 8)
                .map((session) => (
                  <SessionRow key={session.id} session={session} repository={repository} />
                ))
            ) : (
              <EmptyState
                title="No recorded investigations yet."
                description="Bind the CLI to this project and capture a command to start its history."
              />
            )}
          </section>
          {imported && (
            <section className="panel section-padding">
              <SectionHeading
                title="Retained source files"
                description={`${imported.files.length} files from a bounded import. Open a path to inspect its stored text.`}
              />
              {imported.files.length ? (
                <div className="file-list">
                  {imported.files.map((file) => (
                    <details key={file.path} className="source-file">
                      <summary>
                        <Icon name="code" size={14} />
                        <span className="mono">{file.path}</span>
                        <span className="file-size">{(file.size / 1024).toFixed(1)} KiB</span>
                      </summary>
                      <pre className="output-block">{file.text}</pre>
                    </details>
                  ))}
                </div>
              ) : (
                <p className="settings-help">
                  No supported source files were retained in this import.
                </p>
              )}
            </section>
          )}
        </div>
        <aside className="content-stack">
          <section className="panel section-padding">
            <SectionHeading
              title="Capture into this project"
              description="Use this explicit binding from the project root."
            />
            <CopyCommand command={`npm run cli -- init --repository-id ${repository.id}`} />
            <p className="muted-caption">
              Then capture an actual command with the CLI. These instructions do not execute
              anything in the browser.
            </p>
          </section>
          <section className="panel section-padding">
            <SectionHeading title="Repository provenance" />
            <ul className="provenance">
              <li>
                <span>Binding</span>
                <span>Local workspace</span>
              </li>
              <li>
                <span>Created</span>
                <span>
                  <DateLabel value={repository.createdAt} />
                </span>
              </li>
              <li>
                <span>Remote</span>
                <span className="mono">{repository.remoteUrl ?? 'Not recorded'}</span>
              </li>
              {imported && (
                <>
                  <li>
                    <span>Provider</span>
                    <span>{imported.provider}</span>
                  </li>
                  <li>
                    <span>GitHub</span>
                    <span>{imported.fullName}</span>
                  </li>
                  <li>
                    <span>Branch</span>
                    <span className="mono">{imported.defaultBranch}</span>
                  </li>
                  <li>
                    <span>Commit</span>
                    <span className="mono">{imported.commitSha ?? 'Not recorded'}</span>
                  </li>
                  <li>
                    <span>Imported</span>
                    <span>
                      <DateLabel value={imported.importedAt} />
                    </span>
                  </li>
                  <li>
                    <span>Issue metadata</span>
                    <span>{imported.issues.length} retained</span>
                  </li>
                  <li>
                    <span>Pull requests</span>
                    <span>{imported.pullRequests.length} retained</span>
                  </li>
                </>
              )}
            </ul>
          </section>
          {!context.ok ? (
            <div className="notice notice-warning">
              <Icon name="alert" size={17} />
              <div>
                <strong>Imported context could not be loaded.</strong>
                <p>{context.message}</p>
              </div>
            </div>
          ) : (
            !imported && (
              <div className="notice notice-neutral">
                <Icon name="repo" size={17} />
                <div>
                  <strong>Local binding only.</strong>
                  <p>
                    No GitHub code has been imported for this binding. Original command capture
                    remains available.
                  </p>
                </div>
              </div>
            )
          )}
        </aside>
      </div>
    </>
  );
}
