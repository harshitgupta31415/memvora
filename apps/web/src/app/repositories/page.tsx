import Link from 'next/link';
import { GitHubStatusSchema, RepositoryListSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import {
  DateLabel,
  EmptyState,
  ErrorState,
  PageHeading,
  SectionHeading,
  StatusBadge,
} from '@/components/ui';
import { RepositoryForm } from '@/components/repository-form';
import { RefreshButton } from '@/components/controls';
import { GitHubBrowser } from '@/components/github-browser';

export const dynamic = 'force-dynamic';

export default async function Repositories() {
  const [result, github] = await Promise.all([
    apiRequest('/v1/repositories', RepositoryListSchema),
    apiRequest('/v1/github/status', GitHubStatusSchema),
  ]);
  return (
    <>
      <PageHeading
        eyebrow="PROJECT CONTEXT"
        title="Repositories"
        description="Keep each project's investigations connected to the code where they happened."
        action={<RefreshButton />}
      />
      <div className="notice notice-neutral">
        <Icon name="repo" size={19} />
        <div>
          <strong>Local repository bindings</strong>
          <p>
            These projects organize captured command evidence. A local binding is distinct from
            GitHub access or a complete code import.
          </p>
        </div>
      </div>
      {!result.ok ? (
        <ErrorState message={result.message} />
      ) : (
        <>
          <SectionHeading
            title="Your projects"
            action={
              <span className="list-count">
                {result.data.items.length} repositor{result.data.items.length === 1 ? 'y' : 'ies'}
              </span>
            }
          />
          {result.data.items.length ? (
            <div className="repository-grid">
              {result.data.items.map((repo) => (
                <article className="panel repository-card" key={repo.id}>
                  <div className="repo-card-top">
                    <span className="repo-card-icon">
                      <Icon name="repo" size={20} />
                    </span>
                    <div>
                      <h2>
                        <Link href={`/repositories/${repo.id}`}>{repo.name}</Link>
                      </h2>
                      <span className="small text-muted">Personal workspace</span>
                    </div>
                    <StatusBadge status={repo.status} />
                  </div>
                  <div className="repo-path mono">
                    {repo.localPath ?? repo.remoteUrl ?? 'No local path or remote recorded'}
                  </div>
                  {repo.remoteUrl && repo.localPath && (
                    <p className="muted-caption mono">{repo.remoteUrl}</p>
                  )}
                  <div className="repo-card-footer">
                    <span>
                      Added <DateLabel value={repo.createdAt} relative />
                    </span>
                    <Link className="inline-link" href={`/repositories/${repo.id}`}>
                      Open project <Icon name="arrow" size={12} />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="panel">
              <EmptyState
                icon="repo"
                title="Give your engineering memory a starting point."
                description="Add a local repository or initialize the CLI in your project. Its investigations will stay grouped here."
              />
            </div>
          )}
          <RepositoryForm />
          {github.ok ? (
            <GitHubBrowser status={github.data} />
          ) : (
            <div className="notice notice-warning section-top">
              <Icon name="alert" size={17} />
              <div>
                <strong>GitHub connection status is unavailable.</strong>
                <p>{github.message} Local repository capture remains separate.</p>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
