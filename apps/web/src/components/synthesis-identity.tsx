'use client';

import { useState } from 'react';
import { Icon } from './icon';

export function CopySynthesisIdentity({
  requestId,
  inputHash,
}: {
  requestId: string;
  inputHash: string;
}) {
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(`Request ID: ${requestId}\nInput hash: ${inputHash}`);
      setStatus('Copied request ID and input hash.');
    } catch {
      setStatus('Clipboard unavailable. Select the request ID and input hash to copy them.');
    }
  }
  return (
    <div>
      <button
        type="button"
        className="button button-small button-ghost"
        onClick={() => {
          void copy();
        }}
      >
        <Icon name="copy" size={12} />
        Copy request identity
      </button>
      <span className="small text-muted" role="status">
        {status}
      </span>
    </div>
  );
}
