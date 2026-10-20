import Link from 'next/link';
import type { Memory, Repository, Session } from '@memvora/contracts';
import { Icon } from './icon';
import { DateLabel, StatusBadge } from './ui';

export function SessionRow({ session, repository }: { session: Session; repository?: Repository }) {
  return (
    <div className="session-row">
      <span className="session-symbol">
        <Icon name="terminal" size={16} />
      </span>
      <div className="session-row-main">
        <Link href={`/sessions/${session.id}`} className="session-row-title">
          {session.title}
        </Link>
        <div className="session-row-meta">
          <span>{repository?.name ?? 'Repository investigation'}</span>
          <span>·</span>
          <DateLabel value={session.createdAt} relative />
          <span>·</span>
          <span>
            {session.eventCount} command{session.eventCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="session-row-end">
        <StatusBadge status={session.status} />
        <span className="small text-muted">
          {session.memoryCount} memor{session.memoryCount === 1 ? 'y' : 'ies'}
        </span>
      </div>
    </div>
  );
}

export function SourceLinks({ ids }: { ids: string[] }) {
  return (
    <div>
      {ids.map((id, index) => (
        <Link href={`/events/${encodeURIComponent(id)}`} key={id} className="citation-link">
          <Icon name="link" size={10} />
          Source {index + 1}
          <span className="sr-only"> {id}</span>
        </Link>
      ))}
    </div>
  );
}

export function MemoryCard({ memory }: { memory: Memory }) {
  return (
    <article className="memory-card">
      <span className="memory-label">
        <Icon name="link" size={11} />
        {memory.label}
      </span>
      <h3>
        <Link href={`/memories/${memory.id}`}>{memory.title}</Link>
      </h3>
      <p className="memory-summary">{memory.summary}</p>
      <StatusBadge status={memory.outcome} />
      <SourceLinks ids={memory.sources.map((source) => source.id)} />
    </article>
  );
}
