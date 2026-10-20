import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { SessionRecapSchema } from '@memvora/contracts';
import type { CapturedEvent, SessionRecap } from '@memvora/contracts';
import { LocalMemvora } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'recap-api-fixture-credential-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Recap API fixture' });
  const session = store.createSession(service.context(), { repositoryId: repository.id });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  const event = (sequence: number): CapturedEvent => ({
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence,
    startedAt: '2026-10-21T00:00:00.000Z',
    endedAt: '2026-10-21T00:00:01.000Z',
    command: { executable: 'node', args: ['recap-fixture.cjs'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: sequence === 1 ? 1 : 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ ordinal: 0, stream: 'stdout', text: `Stored fixture evidence ${sequence}` }],
    diffs: [],
  });
  return {
    app,
    store,
    service,
    repository,
    session,
    event,
    path: `/v1/sessions/${session.id}/recap`,
  };
}

describe('authorized investigation recap HTTP boundary', () => {
  it('requires authentication and rejects unknown query fields and inaccessible sessions', async () => {
    const { app, path } = fixture();
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `${path}?includeAll=true`, headers })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/sessions/${randomUUID()}/recap`, headers }))
        .statusCode,
    ).toBe(404);
  });

  it('recaps accepted raw evidence while enrichment is pending, without creating summaries or jobs', async () => {
    const { app, path, service, store, event } = fixture();
    const events = [event(1), event(2), event(3)];
    service.ingest(events);
    const before = store.dashboard(service.context()).counts;
    const response = await app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode).toBe(200);
    const recap = response.json<SessionRecap>();
    expect(Check(SessionRecapSchema, recap)).toBe(true);
    expect(recap.counts).toMatchObject({ failed: 1, passed: 2 });
    expect(recap.session.memoryCount).toBe(0);
    expect(recap.steps.map((step) => step.eventId)).toEqual(events.map((item) => item.eventId));
    expect(store.dashboard(service.context()).counts).toEqual(before);
    service.ingest([event(4)]);
    const refreshed = await app.inject({ method: 'GET', url: path, headers });
    expect(refreshed.json<SessionRecap>().coverage.totalEvents).toBe(4);
    expect(recap.coverage.totalEvents).toBe(3);
  });

  it('returns bounded first/last evidence and honest omissions beyond the legacy latest100 window', async () => {
    const { app, path, service, event } = fixture();
    const events = Array.from({ length: 125 }, (_value, index) => event(index + 1));
    for (let index = 0; index < events.length; index += 50)
      service.ingest(events.slice(index, index + 50));
    const response = await app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode).toBe(200);
    const recap = response.json<SessionRecap>();
    expect(Check(SessionRecapSchema, recap)).toBe(true);
    expect(recap.coverage).toMatchObject({
      totalEvents: 125,
      includedEvents: 40,
      omittedEvents: 85,
      selection: 'first_and_last',
    });
    expect(recap.steps[0]!.sequence).toBe(1);
    expect(recap.steps.at(-1)!.sequence).toBe(125);
    expect(recap.sources).toHaveLength(40);
    expect(recap.counts).toMatchObject({ failed: 1, passed: 39 });
  });

  it('does not expose a recap after its parent repository is deleted', async () => {
    const { app, path, service, store, repository, event } = fixture();
    service.ingest([event(1)]);
    store.deleteRepository(service.context(), repository.id);
    const response = await app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Stored fixture evidence');
  });
});
