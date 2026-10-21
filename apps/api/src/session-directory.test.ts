import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { SessionDirectoryPageSchema } from '@memvora/contracts';
import type { SessionDirectoryPage } from '@memvora/contracts';
import { assertSessionDirectoryPage } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from './app.js';

const token = 'session-directory-http-fixture-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function fixture() {
  const store = new SqliteEvidenceStore(':memory:');
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Isolated directory fixture' });
  const app = buildApp({ store, token, embeddedWorker: false });
  apps.push(app);
  const request = (payload: unknown = {}, url = '/v1/sessions/search') =>
    app.inject({ method: 'POST', url, headers, payload });
  return { store, context, repository, app, request };
}

describe('protected investigation directory HTTP boundary', () => {
  it('requires authentication and rejects invalid selectors rather than widening the search', async () => {
    const { app, request } = fixture();
    expect(
      (await app.inject({ method: 'POST', url: '/v1/sessions/search', payload: {} })).statusCode,
    ).toBe(401);
    for (const payload of [
      { extra: true },
      { query: 'x'.repeat(201) },
      { repositoryId: '' },
      { status: 'deleted' },
      { limit: 0 },
      { limit: 51 },
      { cursor: '' },
      { cursor: 'not-a-directory-cursor' },
    ])
      expect((await request(payload)).statusCode).toBe(400);
    expect((await request({}, '/v1/sessions/search?query=ignored')).statusCode).toBe(400);
    expect((await request({ repositoryId: randomUUID() })).statusCode).toBe(404);
  });
  it('finds an old repository-specific title beyond the legacy newest50 window without writing evidence', async () => {
    const { store, context, repository, request } = fixture();
    const old = store.createSession(context, {
      repositoryId: repository.id,
      title: 'Old CAFÉ migration 100%_literal',
    });
    // Make age deterministic even if the fixture creates many sessions within one clock tick.
    expect(store.path).toBe(':memory:');
    (store as unknown as { database: DatabaseSync }).database
      .prepare('UPDATE local_sessions SET created_at=? WHERE id=?')
      .run('2026-01-01T00:00:00.000Z', old.id);
    store.closeSession(context, old.id);
    const other = store.createRepository(context, { name: 'Later unrelated work' });
    for (let index = 0; index < 130; index++)
      store.createSession(context, { repositoryId: other.id, title: `Recent work ${index}` });
    expect(store.sessions(context).some((item) => item.id === old.id)).toBe(false);
    const before = store.dashboard(context);
    const query = {
      query: 'cafe\u0301 migration 100%_',
      repositoryId: repository.id,
      status: 'closed' as const,
      limit: 1,
    };
    const response = await request(query);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const page = response.json<SessionDirectoryPage>();
    expect(Check(SessionDirectoryPageSchema, page)).toBe(true);
    expect(() => assertSessionDirectoryPage(page, query)).not.toThrow();
    expect(page.items.map((item) => item.id)).toEqual([old.id]);
    expect(page.page).toMatchObject({ totalMatching: 1, returnedItems: 1, nextCursor: null });
    expect(store.dashboard(context)).toEqual(before);
  });
  it('pages exact matching IDs and rejects changed filters while leaving legacy list behavior intact', async () => {
    const { store, context, repository, request, app } = fixture();
    for (let index = 0; index < 6; index++)
      store.createSession(context, {
        repositoryId: repository.id,
        title: `Directory match ${index}`,
      });
    const query = { query: 'Directory match', repositoryId: repository.id, limit: 2 };
    const first = (await request(query)).json<SessionDirectoryPage>();
    expect(first.page.nextCursor).toBeTruthy();
    const secondResponse = await request({ ...query, cursor: first.page.nextCursor });
    expect(secondResponse.statusCode).toBe(200);
    const second = secondResponse.json<SessionDirectoryPage>();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    for (const changed of [{ query: 'other' }, { status: 'closed' }])
      expect(
        (await request({ ...query, ...changed, cursor: first.page.nextCursor })).statusCode,
      ).toBe(400);
    const legacy = await app.inject({ method: 'GET', url: '/v1/sessions?limit=1', headers });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().items).toHaveLength(1);
  });
  it('includes journal-only and empty investigations and returns a true zero-result page', async () => {
    const { store, context, repository, request } = fixture();
    const journal = store.createSession(context, {
      repositoryId: repository.id,
      title: 'Journal-only investigation',
    });
    store.createSessionNote(context, journal.id, {
      id: randomUUID(),
      kind: 'note',
      body: 'An explicit author statement.',
      eventIds: [],
    });
    store.createSession(context, { repositoryId: repository.id, title: 'Empty investigation' });
    const page = (await request({ repositoryId: repository.id })).json<SessionDirectoryPage>();
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.eventCount === 0)).toBe(true);
    const empty = (
      await request({ query: 'Nothing-matches-this-title' })
    ).json<SessionDirectoryPage>();
    expect(empty.items).toEqual([]);
    expect(empty.page).toMatchObject({ totalMatching: 0, nextCursor: null });
  });
  it('denies a formerly authorized repository and cursor after parent deletion', async () => {
    const { store, context, repository, request } = fixture();
    for (let index = 0; index < 3; index++)
      store.createSession(context, { repositoryId: repository.id, title: 'Delete fixture' });
    const first = (
      await request({ repositoryId: repository.id, limit: 1 })
    ).json<SessionDirectoryPage>();
    store.deleteRepository(context, repository.id);
    const deleted = await request({
      repositoryId: repository.id,
      limit: 1,
      cursor: first.page.nextCursor,
    });
    expect(deleted.statusCode).toBe(404);
    expect(deleted.body).not.toContain('Delete fixture');
    expect((await request()).json<SessionDirectoryPage>().items).toEqual([]);
  });
});
