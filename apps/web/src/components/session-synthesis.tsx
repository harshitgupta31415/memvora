'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import {
  SessionSynthesisPreviewSchema,
  SessionSynthesisResponseSchema,
  type CreateSessionSynthesis,
  type SessionSynthesisPreview,
  type SessionSynthesisResponse,
} from '@memvora/contracts';
import { getJson, submitJson } from '@/lib/client-api';
import { retainedSynthesisAttempt } from '@/lib/session-synthesis';
import { SourceLinks, SourceList } from './evidence';
import { DateLabel } from './ui';
import { Icon } from './icon';
import styles from './session-synthesis.module.css';

const failureLabels = {
  PROVIDER_FAILED: 'The provider request failed. No verified interpretation was produced.',
  INTERRUPTED: 'Processing was interrupted. This request is not automatically retried.',
  INPUT_CHANGED: 'The evidence changed before this request could complete.',
  CONFIGURATION_CHANGED: 'The provider configuration changed before this request could complete.',
};

export function SessionSynthesisPanel({
  sessionId,
  initialPreview,
  initialStatus,
}: {
  sessionId: string;
  initialPreview: SessionSynthesisPreview;
  initialStatus: SessionSynthesisResponse;
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<CreateSessionSynthesis | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const busy = useRef(false);
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/synthesis`;
  const request = status.request;
  const analysis = request?.analysis;
  const uncertain = attempt !== null && !confirmed;
  async function action(kind: 'submit' | 'status' | 'preview') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      if (kind === 'preview') {
        const next = await getJson(`${path}/preview`, SessionSynthesisPreviewSchema);
        if (next.sessionId !== sessionId || next.repositoryId !== preview.repositoryId)
          throw new Error('The preview does not match this investigation.');
        setPreview(next);
        // This explicit action prepares a different attempt; no model work is requested.
        setAttempt(null);
        setConfirmed(false);
      } else {
        const input =
          kind === 'submit'
            ? retainedSynthesisAttempt(preview, attempt, () => crypto.randomUUID())
            : attempt;
        if (kind === 'submit') setAttempt(input);
        const requestId = input?.requestId ?? request?.id;
        const next =
          kind === 'submit' && input
            ? await submitJson(path, input, SessionSynthesisResponseSchema)
            : await getJson(
                `${path}${requestId ? `?${new URLSearchParams({ requestId })}` : ''}`,
                SessionSynthesisResponseSchema,
              );
        if (
          next.sessionId !== sessionId ||
          (requestId && next.request?.id !== requestId) ||
          (next.request && next.request.repositoryId !== preview.repositoryId) ||
          (input && next.request?.inputHash !== input.expectedInputHash)
        )
          throw new Error(
            'The response does not match this investigation and request. Keep the original retry identity.',
          );
        setStatus(next);
        if (input && next.request?.id === input.requestId) setConfirmed(true);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request could not be confirmed.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const canRequest = (preview.availability === 'available' || uncertain) && !confirmed;
  const claim = (item: NonNullable<typeof analysis>['overview'], index: number) => (
    <li key={index}>
      <p>{item.text}</p>
      <SourceLinks ids={item.sourceIds} sources={request?.sources ?? []} />
    </li>
  );
  return (
    <div className={styles.layout}>
      <section className={`panel ${styles.panel}`} aria-labelledby="synthesis-review-title">
        <p className={styles.eyebrow}>REVIEW BEFORE REQUESTING</p>
        <h2 id="synthesis-review-title">Bounded evidence preview</h2>
        <p className={styles.notice}>
          Requesting interpretation sends this selected evidence to the configured provider. Reading
          or refreshing this page does not invoke a model.
        </p>
        <dl className={styles.facts}>
          <div>
            <dt>Availability</dt>
            <dd>
              {preview.availability === 'available'
                ? 'Available for explicit request'
                : preview.availability === 'disabled'
                  ? 'Disabled'
                  : 'Insufficient evidence'}
            </dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{preview.configuration?.provider ?? 'Not configured'}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{preview.configuration?.model ?? 'Not configured'}</dd>
          </div>
          <div>
            <dt>Commands included</dt>
            <dd>
              {preview.coverage.includedEvents} / {preview.coverage.totalEvents} ·{' '}
              {preview.coverage.omittedEvents} omitted
            </dd>
          </div>
          <div>
            <dt>Authored notes included</dt>
            <dd>
              {preview.coverage.includedNotes} / {preview.coverage.totalNotes} ·{' '}
              {preview.coverage.omittedNotes} omitted
            </dd>
          </div>
          <div>
            <dt>Prepared input</dt>
            <dd>{preview.inputBytes.toLocaleString()} bytes / 65,536 bytes</dd>
          </div>
        </dl>
        <p className={styles.caption}>
          Output, diff and note excerpts use a {preview.coverage.excerptLimit}-character limit.
          Commands are also bounded. Repository files and derived memories are excluded. Authored
          notes remain unverified claims.
        </p>
        {preview.inputHash && (
          <div className={styles.hash}>
            <span>Reviewed input hash</span>
            <code>{preview.inputHash}</code>
          </div>
        )}
        {preview.notices.length > 0 && (
          <ul className={styles.notices}>
            {preview.notices.map((notice, index) => (
              <li key={index}>{notice}</li>
            ))}
          </ul>
        )}
        {preview.availability === 'disabled' && (
          <p className={styles.caption}>
            Session synthesis must be explicitly enabled in the local server configuration. Existing
            observed recaps and raw evidence remain available.
          </p>
        )}
        {preview.availability === 'insufficient_evidence' && (
          <p className={styles.caption}>
            Capture and sync more investigation evidence, then review a fresh preview.
          </p>
        )}
        <div className={styles.actions}>
          <button
            className="button button-primary"
            disabled={pending || !canRequest}
            onClick={() => {
              void action('submit');
            }}
          >
            <Icon name="spark" size={14} />
            {pending
              ? 'Working…'
              : uncertain
                ? 'Retry same request'
                : confirmed
                  ? 'Request accepted'
                  : 'Request AI interpretation'}
          </button>
          <button
            className="button button-ghost"
            disabled={pending}
            onClick={() => {
              void action('preview');
            }}
          >
            Review latest input
          </button>
        </div>
        {uncertain && (
          <p className={styles.notice} role="status">
            Submission has not been confirmed. Retry preserves the exact request ID and input hash.
            Review latest input deliberately clears this retry identity; an earlier accepted request
            may still be processing.
          </p>
        )}
        {attempt && (
          <div className={styles.hash}>
            <span>Retained request ID</span>
            <code>{attempt.requestId}</code>
            <span>Pinned input hash</span>
            <code>{attempt.expectedInputHash}</code>
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </section>
      <section className={`panel ${styles.panel}`} aria-labelledby="synthesis-result-title">
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>AI INTERPRETATION · UNVERIFIED</p>
            <h2 id="synthesis-result-title">
              {request ? `Request ${request.status}` : 'No interpretation requested'}
            </h2>
          </div>
          <button
            className="button button-small button-ghost"
            disabled={pending}
            onClick={() => {
              void action('status');
            }}
          >
            <Icon name="refresh" size={13} />
            Refresh status
          </button>
        </div>
        <p className={styles.notice}>
          These hypotheses and suggested checks are model interpretations. They are separate from
          captured observations and authored reports, and do not establish the engineer’s thinking,
          a root cause or a confirmed fix.
        </p>
        {!request ? (
          <p className={styles.caption}>
            Use the preview to make an explicit request when session synthesis is available.
          </p>
        ) : (
          <>
            {request.stale && (
              <p className={styles.warning}>
                Stale interpretation: evidence or configuration has changed. This result still
                refers to its original input hash and sources. Review latest input before making
                another explicit request.
              </p>
            )}
            <dl className={styles.facts}>
              <div>
                <dt>Saved provider / model</dt>
                <dd>
                  {request.configuration.provider} / {request.configuration.model}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <DateLabel value={request.createdAt} />
                </dd>
              </div>
              <div>
                <dt>Input coverage</dt>
                <dd>
                  {request.coverage.includedEvents} / {request.coverage.totalEvents} commands;{' '}
                  {request.coverage.includedNotes} / {request.coverage.totalNotes} notes
                </dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>{request.attempts} / 1</dd>
              </div>
            </dl>
            <div className={styles.hash}>
              <span>Original request ID</span>
              <code>{request.id}</code>
              <span>Original input hash</span>
              <code>{request.inputHash}</code>
            </div>
            {(request.status === 'queued' || request.status === 'running') && (
              <p className={styles.caption} role="status">
                {request.status === 'queued'
                  ? 'Waiting for the configured worker.'
                  : 'The configured worker is processing this explicit request.'}{' '}
                Refresh status to check progress; no new request is submitted.
              </p>
            )}
            {request.failureCode && (
              <p className={styles.warning}>{failureLabels[request.failureCode]}</p>
            )}
            {request.status === 'superseded' && (
              <p className={styles.caption}>
                This request was superseded. Its identity is retained; review current evidence
                before making a new explicit request.
              </p>
            )}
            {analysis && (
              <>
                <h3>Overview</h3>
                <ul className={styles.claims}>{claim(analysis.overview, 0)}</ul>
                {(
                  [
                    ['Hypotheses', analysis.hypotheses],
                    ['Unresolved questions', analysis.unresolvedQuestions],
                    ['Suggested checks', analysis.suggestedChecks],
                  ] as const
                ).map(([title, items]) => (
                  <div key={title}>
                    <h3>{title}</h3>
                    {items.length ? (
                      <ul className={styles.claims}>{items.map(claim)}</ul>
                    ) : (
                      <p className={styles.caption}>None reported.</p>
                    )}
                  </div>
                ))}
                <h3>Uncertainty</h3>
                <ul className={styles.notices}>
                  {analysis.uncertainty.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </>
            )}
            <details className={styles.sources}>
              <summary>Inspect original input sources ({request.sources.length})</summary>
              <SourceList sources={request.sources} />
            </details>
            <Link
              href={`/sessions/${encodeURIComponent(sessionId)}/synthesis?${new URLSearchParams({ requestId: request.id })}`}
              className="inline-link"
              prefetch={false}
            >
              Link to this request <Icon name="arrow" size={12} />
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
