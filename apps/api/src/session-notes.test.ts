import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import {
  RecallAnswerSchema,
  SessionNoteResponseSchema,
  SessionNotesPageSchema,
} from '@memvora/contracts';
import type {
  CapturedEvent,
  RecallAnswer,
  SessionNote,
  SessionNotesPage,
} from '@memvora/contracts';
import { LocalMemvora } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'journal-api-fixture-credential-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Journal API fixture' });
  const session = store.createSession(service.context(), { repositoryId: repository.id });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  const event: CapturedEvent = {
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: 1,
    startedAt: '2026-10-21T00:00:00.000Z',
    endedAt: '2026-10-21T00:00:01.000Z',
    command: { executable: 'node', args: ['journal-fixture.cjs'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [],
    diffs: [],
  };
  service.ingest([event]);
  const path = `/v1/sessions/${session.id}/notes`;
  const input = {
    id: randomUUID(),
    kind: 'decision' as const,
    body: 'JournalRecallMarker: selected a bounded parser because the old parsing path accepted an invalid input.',
    eventIds: [event.eventId],
  };
  const post = (payload: unknown = input) =>
    app.inject({ method: 'POST', url: path, headers, payload });
  return { app, store, service, repository, session, event, path, input, post };
}

describe('authorized immutable investigation journal HTTP boundary', () => {
  it('authenticates and rejects forged authors, invalid note bodies and foreign event links', async () => {
    const { app, path, post, input, store, service, repository } = fixture();
    expect((await app.inject({ method: 'POST', url: path, payload: input })).statusCode).toBe(401);
    for (const payload of [
      { ...input, author: { name: 'forged' } },
      { ...input, body: ' ' },
      { ...input, eventIds: [randomUUID()] },
    ]) {
      expect([400, 404]).toContain((await post(payload)).statusCode);
    }
    const other = store.createSession(service.context(), { repositoryId: repository.id });
    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${other.id}/notes`,
      headers,
      payload: input,
    });
    expect(foreign.statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `${path}?includeSecrets=true`, headers })).statusCode,
    ).toBe(400);
  });
  it('saves a durable redacted author report, idempotently retries it and refuses a changed payload', async () => {
    const { app, post, input, event, store, service } = fixture();
    const before = store.dashboard(service.context()).counts;
    const original = {
      ...input,
      kind: 'resolution' as const,
      body: 'Reported resolution: pass\u0000word=private-journal-secret; a later check is still needed.',
    };
    const created = await post(original);
    expect(created.statusCode).toBe(201);
    expect(Check(SessionNoteResponseSchema, created.json())).toBe(true);
    const note = created.json<{ note: SessionNote }>().note;
    expect(note.label).toBe('User-authored — not independently verified');
    expect(note.body).toContain('[REDACTED]');
    expect(note.body).not.toContain('private-journal-secret');
    expect(note.author.id).toBe(service.context().user.id);
    expect(note.sources[0]!.id).toBe(event.eventId);
    const retried = await post(original);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(created.json());
    expect((await post({ ...original, body: 'Changed claim' })).statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/session-notes/${input.id}`, headers })).json(),
    ).toEqual(created.json());
    expect(store.dashboard(service.context()).counts).toEqual(before);
  });
  it('returns user-authored note citations through Ask even while execution enrichment is pending', async () => {
    const { app, post, input, repository, event } = fixture();
    await post();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'JournalRecallMarker', repositoryIds: [repository.id] },
    });
    expect(response.statusCode).toBe(200);
    const answer = response.json<RecallAnswer>();
    expect(Check(RecallAnswerSchema, answer)).toBe(true);
    expect(answer.status).toBe('answered');
    expect(answer.label).toContain('User-authored notes (unverified)');
    expect(answer.answer).toContain("author's claims");
    expect(answer.sources).toContainEqual(
      expect.objectContaining({ id: input.id, kind: 'session_note', sessionId: event.sessionId }),
    );
    expect(answer.sources).toContainEqual(
      expect.objectContaining({ id: event.eventId, kind: 'event' }),
    );
    expect(answer.steps.find((step) => step.sourceIds.includes(input.id))?.text).toContain(
      'User-authored decision',
    );
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'JournalRecallMarker', repositoryIds: [] },
    });
    expect(empty.json<RecallAnswer>().status).toBe('insufficient_evidence');
    expect(empty.body).not.toContain('selected a bounded parser');
  });
  it('recovers recent uncited notes for an interrupted investigation without manufacturing a verified outcome', async () => {
    const { app, post, input, session } = fixture();
    await post({
      ...input,
      body: 'I stopped before verifying the parser workaround.',
      eventIds: [],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'Where did I stop, and what is still unresolved?', sessionId: session.id },
    });
    const answer = response.json<RecallAnswer>();
    expect(response.statusCode).toBe(200);
    expect(answer.steps.some((step) => step.text.includes('I stopped before verifying'))).toBe(
      true,
    );
    expect(answer.uncertainty).toContain('Some retrieved notes have no attached command evidence.');
    expect(answer.sources.some((source) => source.kind === 'session_note')).toBe(true);
  });
  it('resumes a journal-only investigation without requiring an explicit session selector', async () => {
    const { app, store, service, repository } = fixture();
    const session = store.createSession(service.context(), {
      repositoryId: repository.id,
      title: 'Journal-only pause',
    });
    const note = store.createSessionNote(service.context(), session.id, {
      id: randomUUID(),
      kind: 'note',
      body: 'I paused before running the reproduction command.',
      eventIds: [],
    }).note;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'Resume my last investigation', repositoryIds: [repository.id] },
    });
    expect(response.statusCode).toBe(200);
    const answer = response.json<RecallAnswer>();
    expect(answer.status).toBe('answered');
    expect(
      answer.sources.some((source) => source.kind === 'session_note' && source.id === note.id),
    ).toBe(true);
    expect(answer.steps.some((step) => step.text.includes('I paused before running'))).toBe(true);
  });

  it('pages notes independently and removes their details and search results with their parent', async () => {
    const { app, post, input, path, store, service, session, repository } = fixture();
    await post();
    await post({
      ...input,
      id: randomUUID(),
      kind: 'note',
      body: 'Second JournalRecallMarker note',
    });
    const latest = await app.inject({ method: 'GET', url: `${path}?limit=1`, headers });
    expect(Check(SessionNotesPageSchema, latest.json())).toBe(true);
    const page = latest.json<SessionNotesPage>();
    expect(page.totalNotes).toBe(2);
    expect(page.olderBeforeId).toBeTruthy();
    const earlier = await app.inject({
      method: 'GET',
      url: `${path}?limit=1&before=${page.olderBeforeId}`,
      headers,
    });
    expect(earlier.json<SessionNotesPage>().items[0]!.id).toBe(input.id);
    store.deleteSession(service.context(), session.id);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/session-notes/${input.id}`, headers }))
        .statusCode,
    ).toBe(404);
    const search = await app.inject({
      method: 'POST',
      url: '/v1/session-notes/search',
      headers,
      payload: { query: 'JournalRecallMarker', repositoryIds: [repository.id] },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json<{ items: SessionNote[] }>().items).toEqual([]);
  });
});
