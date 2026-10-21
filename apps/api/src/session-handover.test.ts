import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { SessionHandoverSchema, SessionHandoverDownloadSchema } from '@memvora/contracts';
import type { SessionHandover, SessionHandoverDownload } from '@memvora/contracts';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'handover-http-fixture-'.repeat(3);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function fixture() {
  const store = new SqliteEvidenceStore(':memory:');
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Handover HTTP fixture' });
  const session = store.createSession(context, { repositoryId: repository.id });
  store.createSessionNote(context, session.id, {
    id: randomUUID(),
    kind: 'decision',
    body: 'Keep the original failure for review.',
    eventIds: [],
  });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  return { app, store, context, repository, session, path: `/v1/sessions/${session.id}/handover` };
}
describe('authorized handover HTTP boundary', () => {
  it('protects both endpoints and rejects unknown query fields and formats', async () => {
    const { app, path } = fixture();
    for (const suffix of ['', '/download'])
      expect((await app.inject({ method: 'GET', url: `${path}${suffix}` })).statusCode).toBe(401);
    for (const suffix of ['?all=true', '/download?format=html', '/download?format=json&all=true'])
      expect(
        (await app.inject({ method: 'GET', url: `${path}${suffix}`, headers })).statusCode,
      ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/sessions/${randomUUID()}/handover`, headers }))
        .statusCode,
    ).toBe(404);
  });
  it('returns a bounded typed report without creating evidence, memories or jobs', async () => {
    const { app, path, store, context } = fixture();
    const before = store.dashboard(context);
    const response = await app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode).toBe(200);
    expect(Check(SessionHandoverSchema, response.json())).toBe(true);
    expect(response.json<SessionHandover>().coverage).toMatchObject({
      includedEvents: 0,
      includedNotes: 1,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(store.dashboard(context)).toEqual(before);
  });
  it('provides self-contained JSON and safe Markdown with exact filenames and no bearer value', async () => {
    const { app, path, session } = fixture();
    for (const format of ['json', 'markdown']) {
      const response = await app.inject({
        method: 'GET',
        url: `${path}/download?format=${format}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const download = response.json<SessionHandoverDownload>();
      expect(Check(SessionHandoverDownloadSchema, download)).toBe(true);
      expect(download.filename).toBe(
        `memvora-handover-${session.id}.${format === 'json' ? 'json' : 'md'}`,
      );
      expect(download.content).not.toContain(token);
      if (format === 'json')
        expect(Check(SessionHandoverSchema, JSON.parse(download.content))).toBe(true);
      else expect(download.content).toContain('Keep the original failure');
    }
    const defaultDownload = await app.inject({ method: 'GET', url: `${path}/download`, headers });
    expect(defaultDownload.json<SessionHandoverDownload>().format).toBe('markdown');
  });
  it('does not export data after parent deletion', async () => {
    const { app, path, store, context, repository } = fixture();
    store.deleteRepository(context, repository.id);
    for (const suffix of ['', '/download?format=json']) {
      const response = await app.inject({ method: 'GET', url: `${path}${suffix}`, headers });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('Keep the original failure');
    }
  });
});
