import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MemoryResponseSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import { DateLabel, ErrorState, PageHeading, SectionHeading, StatusBadge } from '@/components/ui';
import { SourceLinks } from '@/components/evidence';

export const dynamic = 'force-dynamic';

export default async function MemoryDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiRequest(`/v1/memories/${encodeURIComponent(id)}`, MemoryResponseSchema);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <ErrorState message={result.message} />;
  }
  const { memory } = result.data;
  return (
    <>
      <Link href={`/sessions/${memory.sessionId}`} className="back-link">
        <Icon name="arrow" size={13} />
        Back to investigation
      </Link>
      <PageHeading
        eyebrow="LINKED MEMORY"
        title={memory.title}
        description="A traceable reconstruction of recorded work. Follow each source back to the original command."
        action={<StatusBadge status={memory.outcome} />}
      />
      <div className="two-column">
        <article className="panel answer-panel" style={{ marginTop: 0 }}>
          <span className="memory-label">{memory.label}</span>
          <p className="answer-body">{memory.summary}</p>
          <ol className="answer-steps">
            {memory.steps.map((step, index) => (
              <li key={index}>
                <div>
                  {step.text}
                  <SourceLinks ids={step.sourceIds} />
                </div>
              </li>
            ))}
          </ol>
          {memory.uncertainty.length > 0 && (
            <div className="uncertainty">
              <strong>Conditions and uncertainty</strong>
              <ul>
                {memory.uncertainty.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </article>
        <aside className="panel section-padding">
          <SectionHeading
            title="Original sources"
            description={`${memory.sources.length} linked execution event${memory.sources.length === 1 ? '' : 's'}`}
          />
          <div className="source-list">
            {memory.sources.map((source, index) => (
              <Link
                key={source.id}
                className="source-item"
                href={`/events/${encodeURIComponent(source.id)}`}
              >
                <Icon name="terminal" size={15} />
                <span>
                  Command evidence {index + 1}
                  <br />
                  <span className="muted-caption mono">{source.id.slice(0, 8)}</span>
                </span>
                <Icon name="arrow" size={12} />
              </Link>
            ))}
          </div>
          <p className="muted-caption">
            Created <DateLabel value={memory.createdAt} />
            <br />
            Mode: {memory.mode}. The recorded sources remain authoritative.
          </p>
        </aside>
      </div>
    </>
  );
}
