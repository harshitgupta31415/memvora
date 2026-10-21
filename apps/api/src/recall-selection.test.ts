import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvent, RecallAnswer } from '@memvora/contracts';
import { RecallAnswerSchema } from '@memvora/contracts';
import { Check } from 'typebox/value';
import { LocalMemvora } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'synthetic-recall-selection-token-at-least-32-characters';
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function fixture() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const context = service.context();
  const repository = service.createRepository({ name: 'Synthetic recall selection' });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  const session = () => store.createSession(context, { repositoryId: repository.id });
  const event = (sessionId: string, sequence: number, output: string): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId,
    sequence,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'node', args: ['synthetic-check.js'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ stream: 'stderr', ordinal: 0, text: output }],
    diffs: [],
  });
  const ask = async (query: string): Promise<RecallAnswer> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: { authorization: `Bearer ${token}` },
      payload: { query, repositoryIds: [repository.id], limit: 20 },
    });
    expect(response.statusCode).toBe(200);
    const answer = response.json<RecallAnswer>();
    expect(Check(RecallAnswerSchema, answer)).toBe(true);
    return answer;
  };
  return { store, service, context, repository, session, event, ask };
}

function expectRepresented(answer: RecallAnswer, events: CapturedEvent[]) {
  const citations = new Set(answer.sources.map((source) => source.id));
  const displayed = new Set(answer.steps.flatMap((step) => step.sourceIds));
  for (const event of events) {
    expect(citations.has(event.eventId)).toBe(true);
    expect(displayed.has(event.eventId)).toBe(true);
  }
  for (const step of answer.steps)
    for (const id of step.sourceIds) expect(citations.has(id)).toBe(true);
  const eventIds = new Set(
    answer.sources.filter((source) => source.kind === 'event').map((source) => source.id),
  );
  const displayedEventIds = new Set(
    answer.steps.flatMap((step) => step.sourceIds).filter((id) => eventIds.has(id)),
  );
  expect(displayedEventIds.size).toBeLessThanOrEqual(10);
  expect(answer.steps.length).toBeLessThanOrEqual(30);
}

describe('bounded Ask evidence selection', () => {
  it('retains distant direct matches before spending the budget on surrounding events', async () => {
    const f = fixture();
    const session = f.session();
    const query = 'DistantRecallAnchorError';
    const events = Array.from({ length: 14 }, (_, index) =>
      f.event(
        session.id,
        index + 1,
        index === 3 || index === 10 ? query : 'Unrelated housekeeping',
      ),
    );
    f.service.ingest(events);
    const before = f.store.dashboard(f.context);
    const answer = await f.ask(query);
    expectRepresented(answer, [events[3]!, events[10]!]);
    const sequence = new Map(events.map((event) => [event.eventId, event.sequence]));
    const returned = answer.sources
      .filter((source) => source.kind === 'event')
      .map((source) => sequence.get(source.id)!);
    expect(returned).toEqual([...returned].sort((a, b) => a - b));
    expect(answer.uncertainty.join(' ')).toContain('bounded');
    expect(f.store.dashboard(f.context)).toEqual(before);
  });

  it('keeps an anchor from each of the first three ranked investigations', async () => {
    const f = fixture();
    const query = 'CrossInvestigationAnchorError';
    const anchors: CapturedEvent[] = [];
    for (let group = 0; group < 3; group++) {
      const session = f.session();
      const events = Array.from({ length: 7 }, (_, index) =>
        f.event(session.id, index + 1, index === 3 ? query : 'Unrelated surrounding command'),
      );
      anchors.push(events[3]!);
      f.service.ingest(events);
    }
    const answer = await f.ask(query);
    expectRepresented(answer, anchors);
    const sessions = new Set(
      answer.sources
        .filter((source) => source.kind === 'event')
        .map((source) => f.store.getEvent(f.context, source.id).sessionId),
    );
    expect(sessions.size).toBe(3);
  });

  it('preserves a displayed cited step for every selected event when verbose memories exceed thirty steps', async () => {
    const f = fixture();
    const session = f.session();
    const query = 'VerboseRecallAnchorError';
    const events = Array.from({ length: 10 }, (_, index) => ({
      ...f.event(session.id, index + 1, query),
      diffs: [
        {
          phase: 'after' as const,
          text: 'diff --git a/synthetic.js b/synthetic.js\n+observed',
          truncatedBytes: 0,
        },
      ],
    }));
    f.service.ingest(events);
    const answer = await f.ask(query);
    expectRepresented(answer, events);
    expect(answer.steps).toHaveLength(30);
    expect(answer.uncertainty.join(' ')).toContain('shortened');
  });

  it('discloses omitted investigations rather than adding matches beyond the three-session budget', async () => {
    const f = fixture();
    const query = 'ManyInvestigationsRecallError';
    const events = Array.from({ length: 4 }, () => f.event(f.session().id, 1, query));
    f.service.ingest(events);
    const ranking = f.store.search(f.context, {
      query,
      repositoryIds: [f.repository.id],
      limit: 20,
    });
    const answer = await f.ask(query);
    expectRepresented(
      answer,
      ranking.slice(0, 3).map((match) => f.store.getEvent(f.context, match.id)),
    );
    expect(answer.sources).toHaveLength(3);
    expect(answer.uncertainty.join(' ')).toContain('matching');
    expect(answer.sources.some((source) => source.id === ranking[3]!.id)).toBe(false);
  });

  it('keeps ten overlapping anchors represented alongside five notes and five file excerpts', async () => {
    const f = fixture();
    const session = f.session();
    const query = 'MixedRecallCoverageError';
    const events = Array.from({ length: 10 }, (_, index) => f.event(session.id, index + 1, query));
    const linked = f.event(
      session.id,
      30,
      'Additional authored-note evidence outside selected command windows',
    );
    f.service.ingest([...events, linked]);
    for (let index = 0; index < 5; index++)
      f.store.createSessionNote(f.context, session.id, {
        id: randomUUID(),
        kind: 'note',
        body: `${query} authored note ${index}`,
        eventIds: [events[index]!.eventId, ...(index === 0 ? [linked.eventId] : [])],
      });
    f.store.saveRepositoryContext(f.context, f.repository.id, {
      provider: 'github',
      fullName: 'synthetic/recall',
      defaultBranch: 'main',
      commitSha: null,
      importedAt: '2026-10-21T10:00:00.000Z',
      files: Array.from({ length: 5 }, (_, index) => ({
        path: `src/synthetic-${index}.ts`,
        sha: `synthetic-blob-${index}`,
        size: query.length,
        text: query,
      })),
      issues: [],
      pullRequests: [],
    });
    const before = f.store.dashboard(f.context);
    const answer = await f.ask(query);
    expectRepresented(answer, events);
    expect(answer.sources.filter((source) => source.kind === 'event')).toHaveLength(11);
    expect(answer.sources.some((source) => source.id === linked.eventId)).toBe(true);
    expect(answer.steps.some((step) => step.sourceIds.includes(linked.eventId))).toBe(false);
    expect(answer.sources.filter((source) => source.kind === 'session_note')).toHaveLength(5);
    expect(answer.sources.filter((source) => source.kind === 'repository_file')).toHaveLength(5);
    expect(new Set(answer.sources.map((source) => source.id)).size).toBe(answer.sources.length);
    expect(answer.steps).toHaveLength(30);
    expect(answer.uncertainty.join(' ')).toContain('untrusted');
    expect(answer.label).toContain('unverified');
    expect(f.store.dashboard(f.context)).toEqual(before);
  });

  it('does not reconstruct a cached command after its parent is deleted during recall', () => {
    const f = fixture();
    const session = f.session();
    const query = 'ConcurrentDeletedRecallError';
    const event = f.event(session.id, 1, query);
    f.service.ingest([event]);
    const readMemory = f.store.getMemory.bind(f.store);
    const interrupted = vi.spyOn(f.store, 'getMemory').mockImplementationOnce((context, id) => {
      f.store.deleteSession(context, session.id);
      return readMemory(context, id);
    });
    try {
      expect(() =>
        f.service.ask({ query, repositoryIds: [f.repository.id] }, 'deleted-during-recall'),
      ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    } finally {
      interrupted.mockRestore();
    }
    expect(() => f.store.getEvent(f.context, event.eventId)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
