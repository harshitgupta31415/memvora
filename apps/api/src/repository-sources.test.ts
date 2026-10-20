import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapturedEvent,
  RecallAnswer,
  RepositoryContext,
  RepositorySourceDetail,
  RepositorySourceSearchResponse,
} from '@memvora/contracts';
import { LocalMemvora, runEnrichmentOnce } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'repository-source-api-fixture-token-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Deliberately labeled test data, never a production or provider result. */
function contextFixture(text: string, commit = 'a'.repeat(40)): RepositoryContext {
  return {
    provider: 'github',
    fullName: 'fixture-owner/fixture-repository',
    defaultBranch: 'main',
    commitSha: commit,
    importedAt: '2026-10-21T09:00:00.000Z',
    files: [
      { path: 'src/context-fixture.ts', sha: 'c'.repeat(40), size: Buffer.byteLength(text), text },
    ],
    issues: [],
    pullRequests: [],
  };
}

function setup() {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = service.createRepository({ name: 'Repository source API fixture' });
  const session = store.createSession(service.context(), {
    repositoryId: repository.id,
    title: 'Fixture investigation',
  });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  const text =
    'export const fixtureVersion = 1;\nexport const MeridianContext = "recorded source fixture";\nexport function fixtureLookup() { return MeridianContext; }\n';
  service.saveRepositoryContext(repository.id, contextFixture(text));
  return { app, store, service, repository, session, text };
}

async function search(
  app: ReturnType<typeof buildApp>,
  query = 'MeridianContext',
  repositoryIds?: string[],
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/repository-sources/search',
    headers,
    payload: { query, ...(repositoryIds === undefined ? {} : { repositoryIds }) },
  });
  expect(response.statusCode).toBe(200);
  return response.json<RepositorySourceSearchResponse>();
}

describe('imported repository source HTTP boundary', () => {
  it('requires authentication and validates source queries and line ranges', async () => {
    const { app } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/repository-sources/search',
          payload: { query: 'MeridianContext' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/repository-sources/${randomUUID()}` }))
        .statusCode,
    ).toBe(401);
    for (const payload of [{ query: '' }, { query: 'MeridianContext', unscoped: true }]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/repository-sources/search',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    const source = (await search(app)).items[0]!.source;
    for (const query of ['startLine=0', 'limit=201', 'startLine=not-a-number']) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/repository-sources/${source.id}?${query}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (await app.inject({ method: 'GET', url: `/v1/repository-sources/${randomUUID()}`, headers }))
        .statusCode,
    ).toBe(404);
  });

  it('answers a file-only question with an immutable citation that opens a bounded source range', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'MeridianContext', repositoryIds: [repository.id] },
    });
    expect(response.statusCode).toBe(200);
    const answer = response.json<RecallAnswer>();
    expect(answer.status).toBe('answered');
    const citation = answer.sources.find((source) => source.kind === 'repository_file');
    expect(citation).toBeDefined();
    if (!citation || citation.kind !== 'repository_file')
      throw new Error('Expected fixture code citation.');
    expect(citation).toMatchObject({
      repositoryId: repository.id,
      path: 'src/context-fixture.ts',
      commitSha: 'a'.repeat(40),
    });
    expect(answer.steps.some((step) => step.sourceIds.includes(citation.id))).toBe(true);
    const opened = await app.inject({ method: 'GET', url: citation.locator, headers });
    expect(opened.statusCode).toBe(200);
    const { document } = opened.json<{ document: RepositorySourceDetail }>();
    expect(document.source.id).toBe(citation.id);
    expect(document.excerpt).toContain('MeridianContext');
    const range = await app.inject({
      method: 'GET',
      url: `/v1/repository-sources/${citation.id}?startLine=2&limit=1`,
      headers,
    });
    expect(range.statusCode).toBe(200);
    expect(range.json<{ document: RepositorySourceDetail }>().document).toMatchObject({
      startLine: 2,
      endLine: 2,
      hasBefore: true,
      hasAfter: true,
    });
    expect(range.json<{ document: RepositorySourceDetail }>().document.excerpt).toContain(
      'recorded source fixture',
    );
    expect(answer.uncertainty.length).toBeGreaterThan(0);
  });

  it('keeps command evidence and source code citations together without orphan step references', async () => {
    const { app, service, store, repository, session } = setup();
    const event: CapturedEvent = {
      eventId: randomUUID(),
      repositoryId: repository.id,
      sessionId: session.id,
      sequence: 1,
      startedAt: '2026-10-21T09:00:00.000Z',
      endedAt: '2026-10-21T09:00:01.000Z',
      command: { executable: 'node', args: ['fixture-script.cjs'], shell: 'direct' },
      cwd: '.',
      git: { commitSha: null, dirty: false },
      outcome: { kind: 'completed', exitCode: 1, signal: null },
      capture: { complete: true, truncatedBytes: 0, redacted: true },
      output: [{ stream: 'stderr', ordinal: 0, text: 'MeridianContext fixture command failed' }],
      diffs: [],
    };
    service.ingest([event]);
    await runEnrichmentOnce(store);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'MeridianContext', repositoryIds: [repository.id] },
    });
    expect(response.statusCode).toBe(200);
    const answer = response.json<RecallAnswer>();
    expect(
      answer.sources.some((source) => source.kind === 'event' && source.id === event.eventId),
    ).toBe(true);
    expect(answer.sources.some((source) => source.kind === 'repository_file')).toBe(true);
    const ids = new Set(answer.sources.map((source) => source.id));
    for (const step of answer.steps)
      for (const id of step.sourceIds) expect(ids.has(id)).toBe(true);
  });

  it('does not widen denied or empty repository filters and keeps session scope narrow', async () => {
    const { app, service, store, repository, session } = setup();
    const other = service.createRepository({ name: 'Other source fixture' });
    service.saveRepositoryContext(
      other.id,
      contextFixture('export const MeridianContext = "other private fixture";\n'),
    );
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/repository-sources/search',
      headers,
      payload: { query: 'MeridianContext', repositoryIds: [randomUUID()] },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain('recorded source fixture');
    expect((await search(app, 'MeridianContext', [])).items).toEqual([]);
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'MeridianContext', repositoryIds: [] },
    });
    expect(empty.json<RecallAnswer>()).toMatchObject({
      status: 'insufficient_evidence',
      sources: [],
    });
    const narrowed = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'MeridianContext', sessionId: session.id },
    });
    expect(narrowed.statusCode).toBe(200);
    const answer = narrowed.json<RecallAnswer>();
    expect(answer.sources.length).toBeGreaterThan(0);
    expect(answer.sources.every((source) => source.repositoryId === repository.id)).toBe(true);
    const disjoint = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'MeridianContext', sessionId: session.id, repositoryIds: [other.id] },
    });
    expect(disjoint.statusCode).toBe(200);
    expect(disjoint.json<RecallAnswer>()).toMatchObject({
      status: 'insufficient_evidence',
      sources: [],
    });
    const recent = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers,
      payload: { query: 'resume last investigation', sessionId: session.id },
    });
    expect(recent.json<RecallAnswer>()).toMatchObject({
      status: 'insufficient_evidence',
      sources: [],
    });
    expect(store.getSession(service.context(), session.id).events).toEqual([]);
  });

  it('keeps old citations stable after reimport while current search follows the newer snapshot', async () => {
    const { app, service, repository } = setup();
    const first = (await search(app)).items[0]!.source;
    service.saveRepositoryContext(
      repository.id,
      contextFixture(
        'export const RevisedContextOnly = "second import fixture";\n',
        'b'.repeat(40),
      ),
    );
    expect((await search(app)).items).toEqual([]);
    const current = (await search(app, 'RevisedContextOnly')).items[0]!.source;
    expect(current.id).not.toBe(first.id);
    expect(current).toMatchObject({ isCurrent: true, commitSha: 'b'.repeat(40) });
    const old = await app.inject({
      method: 'GET',
      url: `/v1/repository-sources/${first.id}`,
      headers,
    });
    expect(old.statusCode).toBe(200);
    const document = old.json<{ document: RepositorySourceDetail }>().document;
    expect(document.source).toMatchObject({
      id: first.id,
      isCurrent: false,
      commitSha: 'a'.repeat(40),
    });
    expect(document.excerpt).toContain('MeridianContext');
    expect(document.excerpt).not.toContain('RevisedContextOnly');
  });

  it('removes current and historical reads on deletion and fences a stale import save', async () => {
    const { app, service, store, repository } = setup();
    const source = (await search(app)).items[0]!.source;
    const staleContext = service.context();
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/repositories/${repository.id}`,
      headers,
      payload: { confirm: true },
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/repository-sources/${source.id}`, headers }))
        .statusCode,
    ).toBe(404);
    expect((await search(app)).items).toEqual([]);
    expect(() =>
      store.saveRepositoryContext(
        staleContext,
        repository.id,
        contextFixture('stale import must not reappear'),
      ),
    ).toThrow();
    const workspaceDeleted = await app.inject({
      method: 'DELETE',
      url: '/v1/workspace',
      headers,
      payload: { confirm: true },
    });
    expect(workspaceDeleted.statusCode).toBe(200);
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/repository-sources/${source.id}`,
      headers,
    });
    expect([403, 404]).toContain(denied.statusCode);
  });
});
