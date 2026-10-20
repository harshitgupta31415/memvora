'use client';

import { useRef, useState } from 'react';
import { RecallAnswerSchema, type RecallAnswer, type Repository } from '@memvora/contracts';
import { submitJson } from '@/lib/client-api';
import { Icon } from './icon';
import { SourceLinks, SourceList } from './evidence';

const prompts = [
  'What failed in my last investigation?',
  'Which commands passed after the earlier failure?',
  'Where did I stop, and what is still unresolved?',
  'Where is repository access checked in the imported code?',
];

export function AskForm({
  repositories,
  initialRepositoryId = '',
  initialQuery = '',
}: {
  repositories: Repository[];
  initialRepositoryId?: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<RecallAnswer | null>(null);
  const [submittedContext, setSubmittedContext] = useState({ question: '', scope: '' });
  const input = useRef<HTMLTextAreaElement>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    setPending(true);
    setError('');
    setAnswer(null);
    setSubmittedContext({
      question: query.trim(),
      scope: repositoryId
        ? (repositories.find((repository) => repository.id === repositoryId)?.name ??
          'Selected repository')
        : 'All local repositories',
    });
    try {
      setAnswer(
        await submitJson(
          '/api/ask',
          {
            query: query.trim(),
            ...(repositoryId ? { repositoryIds: [repositoryId] } : {}),
            limit: 10,
          },
          RecallAnswerSchema,
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Recall could not be completed.');
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <form
        className="ask-composer"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label htmlFor="memory-question" className="sr-only">
          Ask about your recorded work
        </label>
        <textarea
          id="memory-question"
          ref={input}
          className="textarea"
          required
          maxLength={2000}
          value={query}
          disabled={pending}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What would you like to remember about your work?"
        />
        <div className="composer-footer">
          <select
            aria-label="Repository scope for recall"
            className="select"
            value={repositoryId}
            disabled={pending}
            onChange={(event) => setRepositoryId(event.target.value)}
          >
            <option value="">All local repositories</option>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
          <button
            className="button button-primary"
            type="submit"
            disabled={pending || !query.trim()}
          >
            <Icon name={pending ? 'clock' : 'spark'} size={15} />
            {pending ? 'Finding evidence…' : 'Ask Memvora'}
          </button>
        </div>
      </form>
      {error && (
        <p className="form-error section-top" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div className="panel answer-panel" role="status">
          <div className="skeleton skeleton-subheading" />
          <p className="small text-muted">
            Searching recorded work and current imported code, then linking stored sources…
          </p>
        </div>
      )}
      {answer ? (
        <section className="panel answer-panel" aria-live="polite">
          <div className="answer-heading">
            <h2>
              {answer.status === 'answered' ? 'What the evidence shows' : 'More evidence is needed'}
            </h2>
            <span className="memory-label">{answer.label}</span>
          </div>
          <p className="answer-context">
            <strong>{submittedContext.scope}</strong>
            <span>{submittedContext.question}</span>
          </p>
          <p className="answer-body">{answer.answer}</p>
          {answer.steps.length > 0 && (
            <ol className="answer-steps">
              {answer.steps.map((step, index) => (
                <li key={index}>
                  <div>
                    {step.text}
                    <SourceLinks ids={step.sourceIds} sources={answer.sources} />
                  </div>
                </li>
              ))}
            </ol>
          )}
          {answer.sources.length > 0 && (
            <>
              <h3 className="subheading">Original sources</h3>
              <SourceList sources={answer.sources} />
            </>
          )}
          {answer.uncertainty.length > 0 && (
            <div className="uncertainty">
              <strong>Conditions and uncertainty</strong>
              <ul>
                {answer.uncertainty.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="request-id">
            {answer.mode} recall · Request {answer.requestId}
          </p>
        </section>
      ) : (
        !pending && (
          <div className="ask-intro">
            <span className="empty-icon">
              <Icon name="link" size={24} />
            </span>
            <h2>Earlier work is useful context.</h2>
            <p>
              Ask about captured investigations or the current imported code snapshot. Answers link
              back to the stored evidence they use.
            </p>
            <div className="suggested-prompts">
              {prompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="suggested-prompt"
                  onClick={() => {
                    setQuery(prompt);
                    input.current?.focus();
                  }}
                >
                  <span>{prompt}</span>
                  <Icon name="arrow" size={14} />
                </button>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}
