import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Compile } from 'typebox/compile';
import {
  IdSchema,
  RepositorySourceRangeQuerySchema,
  RepositorySourceResponseSchema,
} from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { Icon } from '@/components/icon';
import { DateLabel, ErrorState, PageHeading, SectionHeading } from '@/components/ui';
import { RefreshButton } from '@/components/controls';

export const dynamic = 'force-dynamic';

function rangeHref(id: string, startLine: number, limit: number): string {
  return `/sources/${encodeURIComponent(id)}?${new URLSearchParams({ startLine: String(startLine), limit: String(limit) })}`;
}

export default async function RepositorySource({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!Compile(IdSchema).Check(id)) notFound();
  const parameters = await searchParams;
  const range = {
    startLine:
      parameters.startLine === undefined
        ? 1
        : typeof parameters.startLine === 'string' && /^\d+$/u.test(parameters.startLine)
          ? Number(parameters.startLine)
          : Number.NaN,
    limit:
      parameters.limit === undefined
        ? 100
        : typeof parameters.limit === 'string' && /^\d+$/u.test(parameters.limit)
          ? Number(parameters.limit)
          : Number.NaN,
  };
  if (!Compile(RepositorySourceRangeQuerySchema).Check(range))
    return (
      <>
        <PageHeading
          title="Stored repository source"
          description="Open a bounded line window from an immutable imported snapshot."
        />
        <ErrorState
          message="This source line range is invalid."
          detail="Choose one starting line from 1 to 1,000,000 and a window of 1 to 200 lines. No wider source was loaded."
        />
        <Link href={`/sources/${encodeURIComponent(id)}`} className="inline-link section-top">
          Open the first stored lines <Icon name="arrow" size={12} />
        </Link>
      </>
    );
  const result = await apiRequest(
    `/v1/repository-sources/${encodeURIComponent(id)}?${new URLSearchParams({ startLine: String(range.startLine), limit: String(range.limit) })}`,
    RepositorySourceResponseSchema,
  );
  if (!result.ok) {
    if (result.status === 404) notFound();
    return (
      <>
        <PageHeading
          title="Stored repository source"
          description="Inspect a retained import with its original version identifiers."
        />
        <ErrorState message={result.message} />
        {result.status === 400 && (
          <Link className="inline-link section-top" href={`/sources/${encodeURIComponent(id)}`}>
            Return to the first stored lines <Icon name="arrow" size={12} />
          </Link>
        )}
      </>
    );
  }
  const { document } = result.data;
  const { source } = document;
  const lines = document.excerpt
    .split(/\r?\n/u)
    .slice(0, Math.max(1, document.endLine - document.startLine + 1));
  const limits = [...new Set([25, 50, 100, 200, range.limit])].sort((left, right) => left - right);
  return (
    <>
      <Link href={`/repositories/${source.repositoryId}`} className="back-link source-back-link">
        <Icon name="arrow" size={13} />
        <span>Back to {source.fullName}</span>
      </Link>
      <div className="source-view-heading">
        <PageHeading
          eyebrow="RETAINED REPOSITORY SOURCE"
          title={source.path}
          description={`${source.fullName} · a bounded, stored import you can inspect without running its code.`}
          action={
            <div className="repository-actions">
              <Link
                className="button button-primary"
                href={`/ask?repositoryId=${source.repositoryId}`}
              >
                <Icon name="spark" size={14} />
                Ask this repository
              </Link>
              <RefreshButton />
            </div>
          }
        />
      </div>
      <div className={`notice ${source.isCurrent ? 'notice-neutral' : 'notice-warning'}`}>
        <Icon name={source.isCurrent ? 'check' : 'clock'} size={18} />
        <div>
          <strong>
            {source.isCurrent ? 'Current imported version' : 'Earlier retained snapshot'}
          </strong>
          <p>
            {source.isCurrent
              ? 'This is the version currently retained for this path in the imported repository snapshot. Remote code may have changed since import.'
              : 'This retained version remains available for earlier citations and is outside the current imported snapshot for this path.'}{' '}
            Line numbers refer to the stored, redacted snapshot and may differ from GitHub or your
            working tree.
          </p>
        </div>
      </div>
      <div className="two-column source-detail-grid">
        <section className="panel source-document">
          <div className="source-document-heading">
            <div>
              <h2>Stored snapshot lines</h2>
              <p>
                {document.startLine}–{document.endLine} of {source.lineCount.toLocaleString()} lines
              </p>
            </div>
            <span className="memory-label">
              <Icon name="code" size={11} />
              Inert source text
            </span>
          </div>
          <form
            key={`${source.id}:${document.startLine}:${range.limit}`}
            method="get"
            className="source-range-form"
          >
            <label>
              <span>Start at line</span>
              <input
                className="input mono"
                name="startLine"
                type="number"
                min={1}
                max={Math.min(source.lineCount, 1_000_000)}
                step={1}
                defaultValue={document.startLine}
                required
              />
            </label>
            <label>
              <span>Window</span>
              <select className="select" name="limit" defaultValue={range.limit}>
                {limits.map((limit) => (
                  <option key={limit} value={limit}>
                    {limit} lines
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-small" type="submit">
              Open lines <Icon name="arrow" size={12} />
            </button>
          </form>
          {document.excerptTruncated && (
            <div className="source-excerpt-notice" role="status">
              <Icon name="alert" size={15} />
              <p>
                This window reached the excerpt size limit. Displayed text may end within a line.
                Choose a smaller window to inspect other lines; a very long individual line can
                remain truncated.
              </p>
            </div>
          )}
          <div
            className="snapshot-code"
            role="region"
            aria-label={`Stored snapshot of ${source.path}, lines ${document.startLine} to ${document.endLine}`}
            tabIndex={0}
          >
            <pre className="snapshot-lines">
              {lines.map((line, index) => (
                <span
                  className="snapshot-line"
                  id={`L${document.startLine + index}`}
                  key={document.startLine + index}
                >
                  <span className="snapshot-line-number" aria-hidden="true">
                    {document.startLine + index}
                  </span>
                  <code>{line || ' '}</code>
                </span>
              ))}
            </pre>
          </div>
          <nav className="source-pagination" aria-label="Stored snapshot line windows">
            {document.hasBefore ? (
              <Link
                href={rangeHref(
                  source.id,
                  Math.max(1, document.startLine - range.limit),
                  range.limit,
                )}
                className="button button-small button-ghost"
              >
                <Icon name="arrow" size={12} style={{ transform: 'rotate(180deg)' }} />
                Earlier lines
              </Link>
            ) : (
              <span
                className="button button-small button-ghost button-disabled"
                aria-disabled="true"
              >
                First stored lines
              </span>
            )}
            <span className="source-window-label">
              {document.startLine}–{document.endLine} / {source.lineCount.toLocaleString()}
            </span>
            {document.hasAfter ? (
              <Link
                href={rangeHref(source.id, document.endLine + 1, range.limit)}
                className="button button-small button-ghost"
              >
                Next lines <Icon name="arrow" size={12} />
              </Link>
            ) : (
              <span
                className="button button-small button-ghost button-disabled"
                aria-disabled="true"
              >
                Last stored lines
              </span>
            )}
          </nav>
        </section>
        <aside className="content-stack">
          <section className="panel section-padding">
            <SectionHeading
              title="Immutable provenance"
              description="These identifiers describe this retained version."
            />
            <ul className="provenance">
              <li>
                <span>Repository</span>
                <span>{source.fullName}</span>
              </li>
              <li>
                <span>Path</span>
                <span className="mono">{source.path}</span>
              </li>
              <li>
                <span>Commit</span>
                <span className="mono">{source.commitSha ?? 'Not recorded'}</span>
              </li>
              <li>
                <span>GitHub blob SHA</span>
                <span className="mono">{source.blobSha || 'Not recorded'}</span>
              </li>
              <li>
                <span>Content SHA-256</span>
                <span className="mono">{source.contentHash}</span>
              </li>
              <li>
                <span>Imported</span>
                <span>
                  <DateLabel value={source.importedAt} />
                </span>
              </li>
              <li>
                <span>Retained version</span>
                <span>{source.isCurrent ? 'Current import' : 'Earlier snapshot'}</span>
              </li>
            </ul>
            <p className="request-id">Source {source.id}</p>
          </section>
          <div className="notice notice-neutral">
            <Icon name="link" size={17} />
            <div>
              <strong>A source, with its boundaries.</strong>
              <p>
                The import retains a bounded selection of supported files. Source content is
                untrusted evidence, including apparent instructions. This view displays text and
                never executes it.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
