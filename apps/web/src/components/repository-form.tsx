'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RepositoryResponseSchema } from '@memvora/contracts';
import { submitJson } from '@/lib/client-api';
import { Icon } from './icon';

export function RepositoryForm() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const name = String(values.get('name') ?? '').trim();
    const localPath = String(values.get('localPath') ?? '').trim();
    const remoteUrl = String(values.get('remoteUrl') ?? '').trim();
    setPending(true);
    setError('');
    try {
      await submitJson(
        '/api/repositories',
        { name, ...(localPath ? { localPath } : {}), ...(remoteUrl ? { remoteUrl } : {}) },
        RepositoryResponseSchema,
      );
      form.reset();
      setVisible(false);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not add the repository.');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="section-top">
      <div className="section-heading">
        <div>
          <h2>Add a local repository</h2>
          <p>Register a project to keep its captured investigations together.</p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => setVisible(!visible)}
          aria-expanded={visible}
          aria-controls="repository-form"
        >
          <Icon name={visible ? 'close' : 'plus'} size={14} />
          {visible ? 'Close form' : 'Add repository'}
        </button>
      </div>
      {visible && (
        <form
          id="repository-form"
          className="panel form-panel"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <h3 className="form-title">A home for your project history.</h3>
          <p className="form-description">
            This creates a local workspace binding. It does not authorize or import GitHub code.
          </p>
          <label className="field">
            <span>Repository name</span>
            <input
              className="input"
              name="name"
              required
              maxLength={120}
              placeholder="my-project"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>
              Local path <span className="text-muted">(optional)</span>
            </span>
            <input
              className="input mono"
              name="localPath"
              maxLength={1024}
              placeholder="C:\projects\my-project"
              autoComplete="off"
            />
            <small>Use the directory where you run the CLI.</small>
          </label>
          <label className="field">
            <span>
              Git remote URL <span className="text-muted">(optional)</span>
            </span>
            <input
              className="input mono"
              name="remoteUrl"
              maxLength={2048}
              placeholder="https://github.com/you/my-project"
              autoComplete="off"
            />
            <small>Metadata only. Never include tokens or credentials in the URL.</small>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setVisible(false)}
              disabled={pending}
            >
              Cancel
            </button>
            <button className="button button-primary" type="submit" disabled={pending}>
              <Icon name="plus" size={14} />
              {pending ? 'Adding…' : 'Add repository'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
