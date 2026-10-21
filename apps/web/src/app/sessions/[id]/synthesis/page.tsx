import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Compile } from 'typebox/compile';
import { IdSchema } from '@memvora/contracts';
import { PageHeading, ErrorState } from '@/components/ui';
import { Icon } from '@/components/icon';
import { SessionSynthesisPanel } from '@/components/session-synthesis';
import { SessionSynthesisHistoryPanel } from '@/components/session-synthesis-history';
import { synthesisRequestQuery } from '@/lib/session-synthesis';
import {
  synthesisHistory,
  synthesisPreview,
  synthesisStatus,
} from '@/lib/session-synthesis-server';

export const dynamic = 'force-dynamic';

export default async function Synthesis({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!Compile(IdSchema).Check(id)) notFound();
  const query = synthesisRequestQuery(await searchParams);
  const back = `/sessions/${encodeURIComponent(id)}`;
  if (!query)
    return (
      <>
        <PageHeading
          title="AI interpretation"
          description="Review a valid investigation and optional request."
        />
        <ErrorState message="This interpretation link is invalid." />
        <Link href={`${back}/synthesis`} className="inline-link section-top" prefetch={false}>
          Open latest interpretation
        </Link>
      </>
    );
  const [preview, status, history] = await Promise.all([
    synthesisPreview(id),
    synthesisStatus(id, query.requestId),
    synthesisHistory(id),
  ]);
  if (
    (!preview.ok && preview.status === 404) ||
    (!status.ok && status.status === 404 && query.requestId === undefined)
  )
    notFound();
  return (
    <>
      <Link href={back} className="back-link">
        <Icon name="arrow" size={13} />
        Original investigation
      </Link>
      <PageHeading
        eyebrow="OPTIONAL SESSION SYNTHESIS"
        title="AI interpretation"
        description="Review the bounded evidence and configured provider before explicitly requesting an interpretation. Observed recaps and authored notes remain separate."
      />
      {history.ok ? (
        <SessionSynthesisHistoryPanel
          history={history.data}
          {...(status.ok && status.data.request
            ? { selectedRequestId: status.data.request.id }
            : {})}
        />
      ) : (
        <ErrorState
          message={history.message}
          detail="Retained request history could not be loaded. Existing request details remain independent."
        />
      )}
      {preview.ok && status.ok ? (
        <SessionSynthesisPanel
          key={`${id}:${status.data.request?.id ?? 'none'}`}
          sessionId={id}
          initialPreview={preview.data}
          initialStatus={status.data}
        />
      ) : (
        <>
          <ErrorState
            message={
              !preview.ok
                ? preview.message
                : !status.ok
                  ? status.message
                  : 'Synthesis is unavailable.'
            }
          />
          <Link href={`${back}/synthesis`} className="inline-link section-top" prefetch={false}>
            Open latest status <Icon name="arrow" size={12} />
          </Link>
        </>
      )}
    </>
  );
}
