import Link from 'next/link';
import type { Memory, RecallCitation, Repository, Session } from '@memvora/contracts';
import { noteKindLabel } from '@/lib/note-labels';
import { Icon } from './icon';
import { DateLabel, StatusBadge } from './ui';
import journalStyles from './session-journal.module.css';

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

export function citationHref(source: RecallCitation): string {
  if (source.kind === 'event') return `/events/${encodeURIComponent(source.id)}`;
  if (source.kind === 'session_note') return `/notes/${encodeURIComponent(source.id)}`;
  const limit = Math.max(1, Math.min(200, source.endLine - source.startLine + 1));
  return `/sources/${encodeURIComponent(source.id)}?${new URLSearchParams({ startLine: String(source.startLine), limit: String(limit) })}`;
}

export function SourceLinks({ ids, sources }: { ids: string[]; sources?: RecallCitation[] }) {
  const sourceMap = new Map(sources?.map((source) => [source.id, source]));
  return (
    <div>
      {ids.map((id, index) => {
        const source = sourceMap.get(id);
        if (sources !== undefined && !source)
          return (
            <span key={id} className="citation-unavailable">
              Source {index + 1} unavailable
            </span>
          );
        if (source?.kind === 'session_note')
          return (
            <Link
              href={citationHref(source)}
              key={id}
              className={`citation-link ${journalStyles.noteCitation}`}
              title={`${noteKindLabel(source.noteKind)} by ${source.authorName}. User-authored, not independently verified.`}
              prefetch={false}
            >
              <Icon name="link" size={10} />
              <span>
                Author report {index + 1} (unverified) · {source.authorName} ·{' '}
                <DateLabel value={source.createdAt} />
              </span>
            </Link>
          );
        return (
          <Link
            href={source ? citationHref(source) : `/events/${encodeURIComponent(id)}`}
            key={id}
            className="citation-link"
            title={
              source?.kind === 'repository_file'
                ? `${source.fullName}/${source.path} · stored snapshot lines ${source.startLine}–${source.endLine}`
                : 'Open recorded command evidence'
            }
          >
            <Icon name={source?.kind === 'repository_file' ? 'code' : 'link'} size={10} />
            {source?.kind === 'repository_file'
              ? `Code ${index + 1} · L${source.startLine}–${source.endLine}`
              : `Source ${index + 1}`}
            <span className="sr-only">
              {' '}
              {source?.kind === 'repository_file' ? `${source.path}, stored snapshot lines` : id}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function SourceList({ sources }: { sources: RecallCitation[] }) {
  return (
    <div className="source-list">
      {sources.map((source, index) => (
        <Link
          href={citationHref(source)}
          key={`${source.kind}:${source.id}:${source.kind === 'repository_file' ? source.startLine : 0}`}
          className="source-item"
        >
          <Icon
            name={
              source.kind === 'repository_file'
                ? 'code'
                : source.kind === 'session_note'
                  ? 'link'
                  : 'terminal'
            }
            size={15}
          />
          <span>
            {source.kind === 'repository_file' ? (
              <>
                <strong className="source-path mono">{source.path}</strong>
                <span className="source-caption">
                  {source.fullName} · stored snapshot lines {source.startLine}–{source.endLine}
                </span>
                <span className="source-caption mono">
                  {source.commitSha
                    ? `Commit ${source.commitSha.slice(0, 12)}`
                    : 'Commit not recorded'}{' '}
                  · SHA-256 {source.contentHash.slice(0, 12)}…
                </span>
              </>
            ) : source.kind === 'session_note' ? (
              <>
                <strong>{noteKindLabel(source.noteKind)} · author report</strong>
                <span className="source-caption">
                  By {source.authorName} · <DateLabel value={source.createdAt} />
                </span>
                <span className="source-caption">User-authored — not independently verified</span>
              </>
            ) : (
              <>
                Command evidence {index + 1} <span className="mono">· {source.id.slice(0, 8)}</span>
              </>
            )}
          </span>
          <Icon name="arrow" size={12} />
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
      <SourceLinks ids={memory.sources.map((source) => source.id)} sources={memory.sources} />
    </article>
  );
}
