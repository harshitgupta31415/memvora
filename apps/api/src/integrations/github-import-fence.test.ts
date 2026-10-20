import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError, LocalMemvora } from '@memvora/core';
import { SqliteEvidenceStore } from '@memvora/db';
import { buildApp } from '../app.js';
import { registerGitHubRoutes } from './github.js';

const mocks = vi.hoisted(() => ({ user: vi.fn(), importContext: vi.fn() }));
vi.mock('./github-client.js', async (original) => ({
  ...(await original<typeof import('./github-client.js')>()),
  githubUser: mocks.user,
  importGitHubContext: mocks.importContext,
}));
const apps: ReturnType<typeof buildApp>[] = [];
const token = 'github-import-fence-fixture-token-'.repeat(2);
const headers = { authorization: `Bearer ${token}` };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 123, login: 'fixture-owner', avatarUrl: '' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(remoteUrl?: string) {
  const store = new SqliteEvidenceStore(':memory:');
  const service = new LocalMemvora(store);
  const repository = remoteUrl
    ? service.createRepository({ name: 'Import fence fixture', remoteUrl })
    : null;
  const app = buildApp({
    store,
    token,
    embeddedWorker: false,
    registerIntegrations: registerGitHubRoutes,
  });
  apps.push(app);
  return { app, store, service, repository };
}
const result = () => ({
  repository: {
    id: 1234,
    fullName: 'fixture-owner/import-fence',
    name: 'import-fence',
    private: true,
    description: null,
    defaultBranch: 'main',
    url: 'https://github.com/fixture-owner/import-fence',
  },
  context: {
    provider: 'github',
    fullName: 'fixture-owner/import-fence',
    defaultBranch: 'main',
    commitSha: 'a'.repeat(40),
    importedAt: '2026-10-21T00:00:00Z',
    files: [
      { path: 'fixture.ts', sha: 'b'.repeat(40), size: 21, text: 'export const fixture = true;' },
    ],
    issues: [],
    pullRequests: [],
  },
  partial: true,
});
function deferredImport() {
  let release!: (value: ReturnType<typeof result>) => void;
  let notify!: () => void;
  const started = new Promise<void>((done) => {
    notify = done;
  });
  mocks.importContext.mockImplementation(() => {
    notify();
    return new Promise<ReturnType<typeof result>>((done) => {
      release = done;
    });
  });
  return { started, release: () => release(result()) };
}

describe('GitHub imports across remote waits', () => {
  it.each([
    'https://github.com/fixture-owner/import-fence.git',
    'git@github.com:fixture-owner/import-fence.git',
  ])('does not recreate a deleted target while fetching %s', async (remoteUrl) => {
    const { app, service, store, repository } = setup(remoteUrl);
    const delayed = deferredImport();
    const imported = app.inject({
      method: 'POST',
      url: '/v1/github/import',
      headers,
      payload: { fullName: 'fixture-owner/import-fence' },
    });
    const responsePromise = imported.then((response) => response);
    await delayed.started;
    store.deleteRepository(service.context(), repository!.id);
    delayed.release();
    const response = await responsePromise;
    expect(response.statusCode).toBe(404);
    expect(store.repositories(service.context())).toEqual([]);
    expect(store.searchRepositorySources(service.context(), { query: 'fixture' })).toEqual([]);
  });
  it('does not create a repository after its original workspace was deleted', async () => {
    const { app, service, store } = setup();
    const delayed = deferredImport();
    const responsePromise = app
      .inject({
        method: 'POST',
        url: '/v1/github/import',
        headers,
        payload: { fullName: 'fixture-owner/import-fence' },
      })
      .then((response) => response);
    await delayed.started;
    store.deleteWorkspace(service.context());
    delayed.release();
    expect((await responsePromise).statusCode).toBe(403);
    expect(() => store.context()).toThrow();
  });
  it('preserves the explicit source-history admission error without exposing provider data', async () => {
    const { app, store } = setup('https://github.com/fixture-owner/import-fence');
    mocks.importContext.mockResolvedValue(result());
    vi.spyOn(store, 'saveRepositoryContext').mockImplementation(() => {
      throw new DomainError('SOURCE_HISTORY_LIMIT', 'Retained source history is full.', 413);
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/github/import',
      headers,
      payload: { fullName: 'fixture-owner/import-fence' },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('SOURCE_HISTORY_LIMIT');
    expect(response.body).not.toContain('export const fixture');
    expect(response.body).not.toContain(token);
  });
});
