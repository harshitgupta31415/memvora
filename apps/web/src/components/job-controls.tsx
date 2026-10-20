'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Compile } from 'typebox/compile';
import { JobResponseSchema } from '@memvora/contracts';
import { Icon } from './icon';

export function RetryJobButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, startTransition] = useTransition();

  async function retry() {
    if (busy || accepted) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof value === 'object' &&
          value !== null &&
          'error' in value &&
          typeof value.error === 'object' &&
          value.error !== null &&
          'message' in value.error &&
          typeof value.error.message === 'string'
            ? value.error.message
            : 'The retry was not accepted. Refresh to check the current job state.';
        setError(message);
        return;
      }
      if (!Compile(JobResponseSchema).Check(value)) {
        setError('The retry response could not be verified. Refresh before trying again.');
        return;
      }
      setAccepted(true);
      startTransition(() => router.refresh());
    } catch {
      setError('The response was unavailable. Refresh to check whether the retry was accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="job-action">
      <button
        type="button"
        className="button button-small"
        disabled={busy || accepted || refreshing}
        onClick={() => void retry()}
      >
        <Icon name={accepted ? 'check' : 'refresh'} size={13} />
        {accepted ? 'Retry queued' : busy ? 'Queuing…' : 'Retry summary'}
      </button>
      <span className="sr-only" role="status">
        {accepted ? 'The retry was accepted. The summary is waiting for processing.' : ''}
      </span>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
