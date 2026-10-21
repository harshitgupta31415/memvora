import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { configuredEnricher, createEnricher } from './index.js';

const event: CapturedEvent = {
  eventId: randomUUID(),
  repositoryId: randomUUID(),
  sessionId: randomUUID(),
  sequence: 1,
  startedAt: '2026-10-21T00:00:00Z',
  endedAt: '2026-10-21T00:00:01Z',
  command: { executable: 'node', args: ['check.mjs'], shell: 'direct' },
  cwd: '.',
  git: { commitSha: null, dirty: false },
  outcome: { kind: 'completed', exitCode: 1, signal: null },
  capture: { complete: true, truncatedBytes: 0, redacted: true },
  output: [{ ordinal: 0, stream: 'stderr', text: 'Error: missing configuration' }],
  diffs: [],
};
const config = { baseUrl: 'https://provider.example/v1', apiKey: 'test-key', model: 'test-model' };
const summary = (sourceId: string) => ({
  title: 'Configuration check failed',
  summary: 'The recorded configuration check exited with code 1.',
  steps: [{ text: 'Observed a missing configuration error.', sourceIds: [sourceId] }],
  uncertainty: ['No corrective change was captured.'],
});
const upstream = (value: unknown) =>
  vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    }),
  );

describe('configured enrichment trust boundary', () => {
  it('makes no provider call unless explicitly enabled', () => {
    expect(configuredEnricher({ AI_API_KEY: 'some-key' })).toBeUndefined();
  });
  it('rejects non-local plaintext credentials and invalid endpoint configuration', () => {
    expect(() => createEnricher({ ...config, baseUrl: 'http://provider.example/v1' })).toThrow();
  });
  it('accepts a bounded cited summary and preserves original event identity/outcome', async () => {
    const fetcher = upstream(summary(event.eventId));
    const memory = await createEnricher(config, fetcher)(event);
    expect(memory.mode).toBe('ai');
    expect(memory.id).toBe(event.eventId);
    expect(memory.outcome).toBe('exit 1');
    expect(memory.sources[0]?.id).toBe(event.eventId);
    expect(memory.provenance?.promptVersion).toBe('event-summary-v2');
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(request.messages[1]?.content).toContain('missing configuration');
  });
  it('rejects invented citations rather than laundering them into a stored memory', async () => {
    await expect(createEnricher(config, upstream(summary(randomUUID())))(event)).rejects.toThrow(
      'outside',
    );
  });
  it('keeps fixed baseline and separate HEAD observations in bounded provider excerpts', async () => {
    const fixed = structuredClone(event);
    fixed.git = { commitSha: 'a'.repeat(64), afterCommitSha: 'b'.repeat(64), dirty: true };
    fixed.diffs = ['before', 'after'].map((phase) => ({
      phase: phase as 'before' | 'after',
      baselineCommitSha: 'a'.repeat(64),
      text: 'x'.repeat(5000),
      truncatedBytes: 0,
    }));
    const fetcher = upstream(summary(event.eventId));
    await createEnricher(config, fetcher)(fixed);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const input = JSON.parse(body.messages[1]!.content) as {
      afterCommitSha: string;
      diffs: Array<{ baselineCommitSha: string; text: string }>;
      diffSummary: string;
    };
    expect(input.afterCommitSha).toBe('b'.repeat(64));
    expect(
      input.diffs.every(
        (diff) => diff.baselineCommitSha === 'a'.repeat(64) && diff.text.length === 4000,
      ),
    ).toBe(true);
    expect(input.diffSummary).toContain('Captured snapshot texts match');
    expect(body.messages[0]!.content).toContain('does not prove the command caused');
  });
  it('does not fabricate success on provider outage or malformed output', async () => {
    await expect(
      createEnricher(
        config,
        vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })),
      )(event),
    ).rejects.toThrow('429');
    await expect(createEnricher(config, upstream({ summary: 'invented' }))(event)).rejects.toThrow(
      'contract',
    );
  });
});
