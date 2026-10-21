'use client';

import { useState } from 'react';
import { Icon } from './icon';

export function CopyText({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }
  return (
    <>
      <button type="button" className="button button-small" onClick={() => void copy()}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} />
        {state === 'copied' ? 'Copied' : label}
      </button>
      <span className="sr-only" role="status">
        {state === 'copied' ? `${label} copied.` : ''}
      </span>
      {state === 'failed' && (
        <p className="form-error">Clipboard unavailable. Select the text below to copy it.</p>
      )}
    </>
  );
}
