import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Compile } from 'typebox/compile';
import {
  IdSchema,
  RepositoryContextResponseSchema,
  RepositoryResponseSchema,
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
  if (!Compile(IdSchema).Check(id)) notFound();
  const [repositoryResult, context, sessions] = await Promise.all([
    apiRequest(`/v1/repositories/${encodeURIComponent(id)}`, RepositoryResponseSchema),
    apiRequest(
      `/v1/repositories/${encodeURIComponent(id)}/context`,
      RepositoryContextResponseSchema,
    ),
    apiRequest(`/v1/sessions?repositoryId=${encodeURIComponent(id)}&limit=8`, SessionListSchema),
  ]);
  if (!repositoryResult.ok) {
    if (repositoryResult.status === 404) notFound();
    return <ErrorState message={repositoryResult.message} />;
  }
  const { repository } = repositoryResult.data;
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
        action={
          <div className="repository-actions">
            <Link href={`/ask?repositoryId=${repository.id}`} className="button button-primary">
              <Icon name="spark" size={14} />
              Ask about this project
            </Link>
            <RefreshButton />
          </div>
        }
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
                description={`${imported.files.length} files from a bounded import. Open a stored version to inspect its source lines and provenance.`}
              />
              <p className="muted-caption source-import-note">
                {imported.partial
                  ? 'This import is marked partial.'
                  : 'Import coverage is bounded by supported paths, file sizes, and import limits.'}{' '}
                Line references describe the stored redacted snapshot.
              </p>
              {imported.files.length ? (
                <div className="file-list">
                  {imported.files.map((file) =>
                    file.sourceId ? (
                      <Link
                        key={file.path}
                        href={`/sources/${file.sourceId}`}
                        className="repository-source-row"
                      >
                        <Icon name="code" size={15} />
                        <span className="repository-source-copy">
                          <strong className="mono">{file.path}</strong>
                          <span>Open stored snapshot lines and provenance</span>
                        </span>
                        <span className="file-size">{(file.size / 1024).toFixed(1)} KiB</span>
                        <Icon name="arrow" size={12} />
                      </Link>
                    ) : (
                      <details key={file.path} className="source-file">
                        <summary>
                          <Icon name="code" size={14} />
                          <span className="mono">{file.path}</span>
                          <span className="file-size">{(file.size / 1024).toFixed(1)} KiB</span>
                        </summary>
                        <p className="muted-caption source-file-actions">
                          This file has no retained source link. Reimport the repository to make its
                          stored version available to citations.
                        </p>
                        <pre className="output-block">{file.text}</pre>
                      </details>
                    ),
                  )}
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
