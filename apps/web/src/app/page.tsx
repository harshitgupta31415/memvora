import Link from 'next/link';
import { DashboardSchema, RepositoryListSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon, type IconName } from '@/components/icon';
import { EmptyState, ErrorState, PageHeading, SectionHeading } from '@/components/ui';
import { CopyCommand, RefreshButton } from '@/components/controls';
import { SessionRow } from '@/components/evidence';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  const [dashboard, repositories] = await Promise.all([
    apiRequest('/v1/dashboard', DashboardSchema),
    apiRequest('/v1/repositories', RepositoryListSchema),
  ]);
  const repoMap = new Map(
    repositories.ok ? repositories.data.items.map((repo) => [repo.id, repo]) : [],
  );
  const stats: {
    key: 'repositories' | 'sessions' | 'events' | 'memories';
    label: string;
    detail: string;
    icon: IconName;
  }[] = [
    { key: 'repositories', label: 'Repositories', detail: 'Bound to this workspace', icon: 'repo' },
    {
      key: 'sessions',
      label: 'Investigations',
      detail: 'Recorded work sessions',
      icon: 'terminal',
    },
    {
      key: 'events',
      label: 'Commands captured',
      detail: 'Original execution evidence',
      icon: 'code',
    },
    {
      key: 'memories',
      label: 'Linked memories',
      detail: 'Evidence you can return to',
      icon: 'link',
    },
  ];
  return (
    <>
      <PageHeading
        eyebrow="YOUR ENGINEERING MEMORY"
        title="Pick up where you left off."
        description="Your investigations, the steps you tried, and the evidence behind them. All in one place."
        action={
          <Link href="/ask" className="button button-primary">
            <Icon name="spark" size={15} />
            Ask Memvora
          </Link>
        }
      />
      {!dashboard.ok ? (
        <ErrorState message={dashboard.message} />
      ) : (
        <>
          <div className="stats-grid">
            {stats.map((stat) => (
              <div className="stat-card" key={stat.key}>
                <div className="stat-top">
                  <span>{stat.label}</span>
                  <Icon name={stat.icon} size={16} />
                </div>
                <div className="stat-value">{dashboard.data.counts[stat.key].toLocaleString()}</div>
                <span className="stat-detail">{stat.detail}</span>
              </div>
            ))}
          </div>
          {dashboard.data.counts.events === 0 && (
            <section className="onboarding-banner">
              <span className="onboarding-icon">
                <Icon name="terminal" size={21} />
              </span>
              <div>
                <h2>Your next investigation is worth remembering.</h2>
                <p>
                  Bind a repository, capture a real command with the CLI, and come back here to
                  trace what happened. Successful and failed attempts both belong in the story.
                </p>
                <Link className="inline-link" href="/repositories">
                  Set up your first repository <Icon name="arrow" size={14} />
                </Link>
              </div>
            </section>
          )}
          {dashboard.data.counts.failedJobs > 0 && (
            <div className="notice notice-warning">
              <Icon name="alert" size={18} />
              <div>
                <strong>
                  {dashboard.data.counts.failedJobs} enrichment job
                  {dashboard.data.counts.failedJobs === 1 ? '' : 's'} need attention
                </strong>
                <p>Original events remain available. Check the worker logs for retry details.</p>
              </div>
            </div>
          )}
          <div className="dashboard-grid">
            <section className="panel section-padding">
              <SectionHeading
                title="Recent investigations"
                description="Continue from the original evidence."
                action={<RefreshButton />}
              />
              {dashboard.data.recentSessions.length ? (
                <>
                  {dashboard.data.recentSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      {...(repoMap.get(session.repositoryId)
                        ? { repository: repoMap.get(session.repositoryId)! }
                        : {})}
                    />
                  ))}
                  <div className="section-top">
                    <Link href="/sessions" className="inline-link">
                      View all investigations <Icon name="arrow" size={13} />
                    </Link>
                  </div>
                </>
              ) : (
                <EmptyState
                  title="The timeline starts with your work."
                  description="There are no captured investigations yet. Run a command through Memvora to create the first one."
                  action={
                    <Link href="/repositories" className="button button-small">
                      Connect a project <Icon name="arrow" size={12} />
                    </Link>
                  }
                />
              )}
            </section>
            <aside className="panel section-padding">
              <SectionHeading
                title="A simple way to remember"
                description="Capture now. Recover the context later."
              />
              <ol className="quick-steps">
                <li>
                  <span className="step-index">01</span>
                  <div>
                    <h3>Bind your repository</h3>
                    <p>Use the CLI from your project folder to establish its local binding.</p>
                    <CopyCommand command="npm run cli -- init" />
                  </div>
                </li>
                <li>
                  <span className="step-index">02</span>
                  <div>
                    <h3>Capture real work</h3>
                    <p>Commands, output, errors, and code conditions become recorded evidence.</p>
                    <CopyCommand command="npm run cli -- run -- npm test" />
                  </div>
                </li>
                <li>
                  <span className="step-index">03</span>
                  <div>
                    <h3>Return to the investigation</h3>
                    <p>Open its timeline, inspect sources, or ask Memvora what happened.</p>
                  </div>
                </li>
              </ol>
              <p className="muted-caption">
                Run these starter commands from the project root. Capture is explicit; commands run
                elsewhere are not monitored.
              </p>
            </aside>
          </div>
          <p className="muted-caption">
            {dashboard.data.counts.queuedJobs} background job
            {dashboard.data.counts.queuedJobs === 1 ? '' : 's'} queued · Counts reflect this local
            workspace. Memories currently summarize recorded observations.
          </p>
        </>
      )}
    </>
  );
}
