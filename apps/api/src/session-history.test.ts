import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent, SessionEventsPage } from '@memvora/contracts';
import { LocalMemvora } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'session-history-api-fixture-token-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Session history API fixture' });
  const session = store.createSession(service.context(), {
    repositoryId: repository.id,
    title: 'History fixture',
  });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  const event = (sequence: number): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence,
    startedAt: '2026-10-21T09:00:00.000Z',
    endedAt: '2026-10-21T09:00:01.000Z',
    command: { executable: 'node', args: ['history-fixture.cjs'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      { stream: 'stderr', ordinal: 0, text: `Deliberate history fixture sequence ${sequence}` },
    ],
    diffs: [],
  });
  const seed = (events: CapturedEvent[]) => {
    for (let offset = 0; offset < events.length; offset += 50)
      service.ingest(events.slice(offset, offset + 50));
  };
  return { app, store, service, repository, session, event, seed };
}

async function getPage(
  app: ReturnType<typeof buildApp>,
  sessionId: string,
  cursor?: string,
  limit = 20,
): Promise<SessionEventsPage> {
  const query = new URLSearchParams({
    limit: String(limit),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const response = await app.inject({
    method: 'GET',
    url: `/v1/sessions/${sessionId}/events?${query}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json<SessionEventsPage>();
}

describe('snapshot-paged session history HTTP boundary', () => {
  it('rejects sequences that cannot be represented reliably in navigation boundaries', async () => {
    const { app, event, service, store } = setup();
    const unsafe = event(Number.MAX_SAFE_INTEGER + 1);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/events/batch',
      headers,
      payload: { schemaVersion: 1, events: [unsafe] },
    });
    expect(response.statusCode).toBe(400);
    expect(() => service.ingest([unsafe])).toThrow('positive safe integer');
    expect(store.dashboard(service.context()).counts.events).toBe(0);
  });

  it('authenticates and rejects unknown selectors, malformed cursors and invalid limits', async () => {
    const { app, session, event, seed } = setup();
    seed([event(1), event(2), event(3)]);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/events` })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/sessions/${randomUUID()}/events`, headers }))
        .statusCode,
    ).toBe(404);
    for (const query of [
      'limit=0',
      'limit=51',
      'limit=1.5',
      'limit=invalid',
      'cursor=',
      'cursor=not-a-valid-cursor',
      `cursor=${'a'.repeat(2049)}`,
      'takeAll=true',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${session.id}/events?${query}`,
        headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('Deliberate history fixture');
    }
    const initial = await getPage(app, session.id, undefined, 1);
    expect(initial.page.olderCursor).not.toBeNull();
    const other = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { repositoryId: session.repositoryId, title: 'Other fixture session' },
    });
    expect(other.statusCode).toBe(201);
    const otherId = other.json<{ session: { id: string } }>().session.id;
    const wrongSession = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${otherId}/events?${new URLSearchParams({ cursor: initial.page.olderCursor!, limit: '1' })}`,
      headers,
    });
    expect(wrongSession.statusCode).toBe(400);
    expect(wrongSession.body).not.toContain('Deliberate history fixture');
  });

  it('traverses beyond 100 events in both directions without duplicates or later uploads entering the snapshot', async () => {
    const { app, session, event, seed } = setup();
    const original = Array.from({ length: 125 }, (_value, index) => event(index + 2));
    seed(original);
    const initialResponse = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.id}/events`,
      headers,
    });
    expect(initialResponse.statusCode).toBe(200);
    const initial = initialResponse.json<SessionEventsPage>();
    expect(initial.events.map((item) => item.sequence)).toEqual(
      Array.from({ length: 20 }, (_value, index) => index + 107),
    );
    expect(initial.page).toMatchObject({
      snapshotEventCount: 125,
      returnedEvents: 20,
      firstSequence: 107,
      lastSequence: 126,
      newerCursor: null,
    });
    const lateEarlier = event(1);
    const lateNewer = event(127);
    seed([lateEarlier, lateNewer]);
    const olderIds = initial.events.map((item) => item.eventId);
    let oldest = initial;
    let olderPages = 0;
    while (oldest.page.olderCursor !== null) {
      if (++olderPages > 20) throw new Error('History cursor did not terminate.');
      oldest = await getPage(app, session.id, oldest.page.olderCursor);
      expect(oldest.page.snapshotEventCount).toBe(125);
      expect(oldest.page.returnedEvents).toBe(oldest.events.length);
      expect(oldest.events.map((item) => item.sequence)).toEqual(
        oldest.events.map((item) => item.sequence).sort((a, b) => a - b),
      );
      olderIds.push(...oldest.events.map((item) => item.eventId));
    }
    expect(olderIds).toHaveLength(125);
    expect(new Set(olderIds).size).toBe(125);
    expect(new Set(olderIds)).toEqual(new Set(original.map((item) => item.eventId)));
    expect(olderIds).not.toContain(lateEarlier.eventId);
    expect(olderIds).not.toContain(lateNewer.eventId);
    expect(oldest.page.firstSequence).toBe(2);
    expect(oldest.session.eventCount).toBe(127);

    const newerIds = oldest.events.map((item) => item.eventId);
    let forward = oldest;
    let newerPages = 0;
    while (forward.page.newerCursor !== null) {
      if (++newerPages > 20) throw new Error('Forward history cursor did not terminate.');
      forward = await getPage(app, session.id, forward.page.newerCursor);
      expect(forward.page.snapshotEventCount).toBe(125);
      newerIds.push(...forward.events.map((item) => item.eventId));
    }
    expect(newerIds).toHaveLength(125);
    expect(new Set(newerIds)).toEqual(new Set(original.map((item) => item.eventId)));
    expect(newerIds).not.toContain(lateEarlier.eventId);
    expect(newerIds).not.toContain(lateNewer.eventId);
    const refreshed = await getPage(app, session.id);
    expect(refreshed.page.snapshotEventCount).toBe(127);
    expect(refreshed.events.at(-1)?.eventId).toBe(lateNewer.eventId);
  });

  it('returns honest empty-page metadata and rejects old cursors after confirmed deletion', async () => {
    const { app, session, event, seed } = setup();
    const empty = await getPage(app, session.id);
    expect(empty.events).toEqual([]);
    expect(empty.memories).toEqual([]);
    expect(empty.page).toMatchObject({
      snapshotEventCount: 0,
      returnedEvents: 0,
      firstSequence: null,
      lastSequence: null,
      olderCursor: null,
      newerCursor: null,
    });
    seed([event(1), event(2), event(3)]);
    const initial = await getPage(app, session.id, undefined, 1);
    expect(initial.page.olderCursor).not.toBeNull();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/sessions/${session.id}`,
          headers,
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(200);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.id}/events?${new URLSearchParams({ cursor: initial.page.olderCursor! })}`,
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Deliberate history fixture');
  });
});
