'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icon';

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }
  return (
    <>
      <div className="command-block">
        <span className="command-prompt">$</span>
        <code>{command}</code>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            void copy();
          }}
          aria-label={copied ? 'Command copied' : 'Copy command'}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
      <span className="sr-only" role="status">
        {copied ? 'Command copied.' : ''}
      </span>
      {failed && (
        <p className="form-error">Clipboard unavailable. Select the command text to copy it.</p>
      )}
    </>
  );
}

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      className="button button-small button-ghost"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
    >
      <Icon name="refresh" size={13} />
      {pending ? 'Refreshing…' : 'Refresh'}
    </button>
  );
}
