import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository, Session, SessionEventsPage } from '@memvora/contracts';
import { initializeRepository } from './initialization.js';
import type { gitText } from './capture.js';

const repositoryId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const token = 'private-local-init-fixture-token-at-least-32-characters';
const origin = 'http://127.0.0.1:4000';
const directories: string[] = [];

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'memvora-init-'));
  directories.push(directory);
  return directory;
}

function repository(): Repository {
  return {
    id: repositoryId,
    workspaceId: otherId,
    name: 'Explicit init fixture',
    localPath: null,
    remoteUrl: null,
    status: 'active',
    createdAt: '2026-10-21T00:00:00.000Z',
  };
}

function session(status: 'open' | 'closed' = 'open'): Session {
  return {
    id: sessionId,
    repositoryId,
    title: 'Existing fixture investigation',
    status,
    createdAt: '2026-10-21T00:00:00.000Z',
    closedAt: status === 'closed' ? '2026-10-21T01:00:00.000Z' : null,
    eventCount: 0,
    memoryCount: 0,
  };
}

function sessionPage(status: 'open' | 'closed' = 'open'): SessionEventsPage {
  return {
    session: session(status),
    events: [],
    memories: [],
    page: {
      snapshotEventCount: 0,
      returnedEvents: 0,
      firstSequence: null,
      lastSequence: null,
      olderCursor: null,
      newerCursor: null,
    },
  };
}

function storedBinding(root: string, includeSession = true) {
  const folder = join(root, '.memvora');
  mkdirSync(folder, { recursive: true });
  const config = `${JSON.stringify({ schemaVersion: 1, repositoryId, apiUrl: `${origin}/`, ...(includeSession ? { sessionId } : {}), retainedFixtureField: 'preserve exact bytes' }, null, 4)}\n`;
  const outbox = Buffer.from(
    'Explicit opaque outbox fixture. Init must never open or modify this file.',
  );
  writeFileSync(join(folder, 'config.json'), config);
  writeFileSync(join(folder, 'outbox.sqlite'), outbox);
  writeFileSync(join(folder, '.gitignore'), '*\n# preserve existing policy\n');
  return { folder, config, outbox };
}

function git(root?: string): typeof gitText {
  return vi.fn<typeof gitText>(async (_cwd, args) => ({
    text: args[0] === 'rev-parse' && root ? root : '',
    ok: Boolean(args[0] === 'rev-parse' && root),
    truncatedBytes: 0,
  }));
}

function transport(status: 'open' | 'closed' = 'open') {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    return new Response(
      JSON.stringify(
        path === `/v1/repositories/${repositoryId}` || path === '/v1/repositories'
          ? { repository: repository() }
          : path === '/v1/sessions'
            ? { session: session() }
            : sessionPage(status),
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

beforeEach(() => {
  vi.stubEnv('MEMVORA_LOCAL_TOKEN', token);
  vi.stubEnv('MEMVORA_API_URL', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('memvora-init-'))
      throw new Error('Unexpected init-fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});

describe('idempotent local CLI initialization', () => {
  it.each(['open', 'closed'] as const)(
    'verifies an existing %s investigation twice with only reads and preserves exact local bytes',
    async (status) => {
      const root = fixtureDirectory();
      const stored = storedBinding(root);
      const fetcher = transport(status);
      const options = { cwd: root, repositoryId, apiUrl: origin };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await initializeRepository(options, { git: git(root) });
        expect(result.root).toBe(root);
        expect(result.mode).toBe('existing');
        expect(result.sessionStatus).toBe(status);
        expect(result.binding.sessionId).toBe(sessionId);
        expect(result.binding.apiUrl).toBe(`${origin}/`);
      }
      expect(fetcher).toHaveBeenCalledTimes(4);
      for (const [url, init] of fetcher.mock.calls) {
        expect(init?.method).toBe('GET');
        expect(String(url)).toMatch(/\/v1\/(?:repositories\/|sessions\/)/u);
      }
      expect(readFileSync(join(stored.folder, 'config.json'), 'utf8')).toBe(stored.config);
      expect(readFileSync(join(stored.folder, 'outbox.sqlite'))).toEqual(stored.outbox);
      expect(readFileSync(join(stored.folder, '.gitignore'), 'utf8')).toBe(
        '*\n# preserve existing policy\n',
      );
    },
  );

  it('preserves a repo-only nearest subfolder binding within its Git boundary and ignores an unversioned ancestor', async () => {
    const root = fixtureDirectory();
    const child = join(root, 'bound-subfolder');
    const cwd = join(child, 'deep');
    mkdirSync(cwd, { recursive: true });
    const stored = storedBinding(child, false);
    const fetcher = transport();
    const result = await initializeRepository({ cwd }, { git: git(root) });
    expect(result.root).toBe(child);
    expect(result.sessionStatus).toBeNull();
    expect(result.binding.sessionId).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(stored.folder, 'config.json'), 'utf8')).toBe(stored.config);
    expect(existsSync(join(root, '.memvora'))).toBe(false);
    const unversioned = join(root, 'unversioned');
    mkdirSync(unversioned);
    storedBinding(root);
    const initialized = await initializeRepository(
      { cwd: unversioned, repositoryId },
      { git: git() },
    );
    expect(initialized.root).toBe(unversioned);
    expect(initialized.mode).toBe('created');
  });

  it.each(['cwd_alias', 'git_alias', 'same_alias'] as const)(
    'verifies the nearest existing binding across physical Git aliases (%s) without changing bytes',
    async (variant) => {
      const parent = fixtureDirectory();
      const physicalRoot = join(parent, 'physical-repository');
      const physicalBound = join(physicalRoot, 'bound-subfolder');
      mkdirSync(join(physicalBound, 'deep'), { recursive: true });
      const alias = join(parent, 'repository-alias');
      symlinkSync(physicalRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
      storedBinding(parent);
      const stored = storedBinding(physicalBound);
      const fetcher = transport();
      const cwd = join(variant === 'git_alias' ? physicalRoot : alias, 'bound-subfolder', 'deep');
      const boundary = variant === 'cwd_alias' ? physicalRoot : alias;
      const result = await initializeRepository({ cwd }, { git: git(boundary) });
      expect(result.root).toBe(
        variant === 'same_alias'
          ? join(alias, 'bound-subfolder')
          : realpathSync.native(physicalBound),
      );
      expect(result.mode).toBe('existing');
      expect(result.binding.sessionId).toBe(sessionId);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
      expect(readFileSync(join(stored.folder, 'config.json'), 'utf8')).toBe(stored.config);
      expect(readFileSync(join(stored.folder, 'outbox.sqlite'))).toEqual(stored.outbox);
      expect(existsSync(join(physicalRoot, '.memvora'))).toBe(false);
    },
  );

  it('creates a new binding only within the proven physical Git boundary when cwd uses an alias', async () => {
    const parent = fixtureDirectory();
    const physicalRoot = join(parent, 'physical-repository');
    mkdirSync(join(physicalRoot, 'deep'), { recursive: true });
    const alias = join(parent, 'repository-alias');
    symlinkSync(physicalRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const unrelated = storedBinding(parent);
    const fetcher = transport();
    const result = await initializeRepository(
      { cwd: join(alias, 'deep'), repositoryId },
      { git: git(physicalRoot) },
    );
    expect(result.root).toBe(realpathSync.native(physicalRoot));
    expect(result.mode).toBe('created');
    expect(JSON.parse(readFileSync(join(physicalRoot, '.memvora', 'config.json'), 'utf8'))).toEqual(
      result.binding,
    );
    expect(existsSync(join(physicalRoot, 'deep', '.memvora'))).toBe(false);
    expect(readFileSync(join(unrelated.folder, 'config.json'), 'utf8')).toBe(unrelated.config);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each(['sibling', 'linked_escape'] as const)(
    'rejects a physically outside cwd before requests or writes (%s)',
    async (variant) => {
      const parent = fixtureDirectory();
      const physicalRoot = join(parent, 'physical-repository');
      const foreign = join(parent, 'foreign-repository');
      mkdirSync(physicalRoot);
      mkdirSync(join(foreign, 'deep'), { recursive: true });
      const stored = storedBinding(foreign);
      let cwd = join(foreign, 'deep');
      if (variant === 'linked_escape') {
        const alias = join(physicalRoot, 'outside-link');
        symlinkSync(foreign, alias, process.platform === 'win32' ? 'junction' : 'dir');
        cwd = join(alias, 'deep');
      }
      const fetcher = transport();
      await expect(
        initializeRepository({ cwd, repositoryId }, { git: git(physicalRoot) }),
      ).rejects.toThrow('repository root outside');
      expect(fetcher).not.toHaveBeenCalled();
      expect(existsSync(join(physicalRoot, '.memvora'))).toBe(false);
      expect(existsSync(join(foreign, 'deep', '.memvora'))).toBe(false);
      expect(readFileSync(join(stored.folder, 'config.json'), 'utf8')).toBe(stored.config);
      expect(readFileSync(join(stored.folder, 'outbox.sqlite'))).toEqual(stored.outbox);
    },
  );

  it('fails safely before requests or writes when a reported Git path cannot be canonicalized', async () => {
    const root = fixtureDirectory();
    const fetcher = transport();
    const secretPath = join(root, 'PrivateMissingGitPathFixture');
    const failure = await initializeRepository(
      { cwd: root, repositoryId },
      { git: git(secretPath) },
    ).catch((error: Error) => error);
    expect(String(failure)).toContain('Git repository paths could not be verified');
    expect(String(failure)).not.toContain('PrivateMissingGitPathFixture');
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.memvora'))).toBe(false);
  });

  it('validates UUIDs before requests and rejects mismatched flags/origins or corrupt configs without changes', async () => {
    const root = fixtureDirectory();
    const stored = storedBinding(root);
    const fetcher = transport();
    const readGit = git(root);
    await expect(
      initializeRepository({ cwd: root, repositoryId: '../private' }, { git: readGit }),
    ).rejects.toThrow('valid repository UUID');
    expect(readGit).not.toHaveBeenCalled();
    await expect(
      initializeRepository({ cwd: root, repositoryId: otherId }, { git: readGit }),
    ).rejects.toThrow('differs from the existing binding');
    await expect(
      initializeRepository({ cwd: root, apiUrl: 'http://127.0.0.1:4999' }, { git: readGit }),
    ).rejects.toThrow('conflicts');
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4999');
    await expect(initializeRepository({ cwd: root }, { git: readGit })).rejects.toThrow(
      'conflicts',
    );
    vi.stubEnv('MEMVORA_API_URL', undefined);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFileSync(join(stored.folder, 'config.json'), 'utf8')).toBe(stored.config);
    const corrupt = `not valid JSON ${token}`;
    writeFileSync(join(stored.folder, 'config.json'), corrupt);
    const failure = await initializeRepository({ cwd: root }, { git: readGit }).catch(
      (error: Error) => error,
    );
    expect(String(failure)).toContain('could not be validated');
    expect(String(failure)).not.toContain(token);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFileSync(join(stored.folder, 'config.json'), 'utf8')).toBe(corrupt);
    expect(readFileSync(join(stored.folder, 'outbox.sqlite'))).toEqual(stored.outbox);
  });

  it('fails closed on denied, malformed, wrong-repository and wrong-session responses without touching the outbox', async () => {
    const root = fixtureDirectory();
    const stored = storedBinding(root);
    for (const variant of ['denied', 'malformed', 'repository', 'session', 'sessionRepository']) {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url) => {
          if (String(url).includes('/v1/repositories/')) {
            if (variant === 'denied')
              return new Response(JSON.stringify({ error: { message: token } }), { status: 403 });
            if (variant === 'malformed')
              return new Response(JSON.stringify({ repository: { id: repositoryId } }));
            return new Response(
              JSON.stringify({
                repository: {
                  ...repository(),
                  ...(variant === 'repository' ? { id: otherId } : {}),
                },
              }),
            );
          }
          const page = sessionPage();
          if (variant === 'session') page.session.id = otherId;
          if (variant === 'sessionRepository') page.session.repositoryId = otherId;
          return new Response(JSON.stringify(page));
        }),
      );
      const failure = await initializeRepository({ cwd: root }, { git: git(root) }).catch(
        (error: Error) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(token);
      expect(readFileSync(join(stored.folder, 'config.json'), 'utf8')).toBe(stored.config);
      expect(readFileSync(join(stored.folder, 'outbox.sqlite'))).toEqual(stored.outbox);
    }
  });

  it('initializes an explicit repository through direct lookup and repeated init creates no extra session', async () => {
    const root = fixtureDirectory();
    const fetcher = transport();
    const options = { cwd: root, repositoryId };
    const created = await initializeRepository(options, { git: git(root) });
    expect(created.mode).toBe('created');
    expect(created.binding).toMatchObject({ repositoryId, sessionId, apiUrl: origin });
    const configuration = join(root, '.memvora', 'config.json');
    const bytes = readFileSync(configuration);
    await expect(initializeRepository(options, { git: git(root) })).resolves.toMatchObject({
      mode: 'existing',
      sessionStatus: 'open',
    });
    expect(readFileSync(configuration)).toEqual(bytes);
    expect(readFileSync(join(root, '.memvora', '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(join(root, '.memvora', 'outbox.sqlite'))).toBe(false);
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) =>
          new URL(String(url)).pathname === '/v1/sessions' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/repositories'),
    ).toBe(false);
  });

  it('does not create config from a foreign initial session or overwrite a racing configuration', async () => {
    const root = fixtureDirectory();
    const configuration = join(root, '.memvora', 'config.json');
    const fetcher = transport();
    fetcher.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('/v1/repositories/')
              ? { repository: repository() }
              : { session: { ...session(), repositoryId: otherId } },
          ),
        ),
    );
    await expect(
      initializeRepository({ cwd: root, repositoryId }, { git: git(root) }),
    ).rejects.toThrow('did not match');
    expect(existsSync(configuration)).toBe(false);
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes('/v1/repositories/'))
        return new Response(JSON.stringify({ repository: repository() }));
      mkdirSync(join(root, '.memvora'), { recursive: true });
      writeFileSync(configuration, 'racing config must remain intact');
      return new Response(JSON.stringify({ session: session() }));
    });
    await expect(
      initializeRepository({ cwd: root, repositoryId }, { git: git(root) }),
    ).rejects.toThrow('exclusively');
    expect(readFileSync(configuration, 'utf8')).toBe('racing config must remain intact');
  });

  it('rejects a linked private directory for new setup before issuing a request', async () => {
    const root = fixtureDirectory();
    const target = join(root, 'separate-private-target');
    mkdirSync(target);
    symlinkSync(target, join(root, '.memvora'), 'junction');
    const fetcher = transport();
    await expect(
      initializeRepository({ cwd: root, repositoryId }, { git: git(root) }),
    ).rejects.toThrow('regular local .memvora directory');
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(join(target, 'config.json'))).toBe(false);
  });
});
