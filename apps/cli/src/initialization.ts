import { lstatSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  IdSchema,
  RepositoryResponseSchema,
  SessionEventsPageSchema,
  SessionResponseSchema,
  type Repository,
  type Session,
  type SessionEventsPage,
} from '@memvora/contracts';
import { Check } from 'typebox/value';
import { gitText } from './capture.js';
import {
  apiRequest,
  ensurePrivateDirectory,
  readBinding,
  readToken,
  type Binding,
} from './local.js';

type InitializationOptions = {
  cwd?: string;
  repositoryId?: string;
  apiUrl?: string;
  home?: string;
};
export type InitializationResult = {
  root: string;
  binding: Binding;
  mode: 'existing' | 'created';
  sessionStatus: Session['status'] | null;
};

function origin(value: string): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      'Initialization requires a plain loopback API origin without credentials, path, query or fragment.',
    );
  }
}

function hasEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw new Error(
      'The existing local configuration location could not be inspected. No files were changed.',
    );
  }
}

function within(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    !isAbsolute(difference) &&
    difference !== '..' &&
    !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

/** Search only a proven Git boundary; an unversioned cwd cannot inherit a home/ancestor binding. */
function initializationRoot(cwd: string, gitRoot?: string): string {
  const boundary = gitRoot ?? cwd;
  if (!within(boundary, cwd))
    throw new Error('Git returned a repository root outside the current directory.');
  let location = cwd;
  while (within(boundary, location)) {
    if (hasEntry(join(location, '.memvora', 'config.json'))) return location;
    if (location === boundary) break;
    const parent = dirname(location);
    if (parent === location) break;
    location = parent;
  }
  return boundary;
}

async function repositoryById(apiOrigin: string, token: string, id: string): Promise<Repository> {
  let response: { repository: Repository };
  try {
    response = await apiRequest(apiOrigin, token, `/v1/repositories/${id}`);
  } catch {
    throw new Error(
      'The selected repository could not be verified with this local API credential. No binding was changed.',
    );
  }
  if (!Check(RepositoryResponseSchema, response) || response.repository.id !== id)
    throw new Error(
      'The API repository response did not match the selected identity. No binding was changed.',
    );
  return response.repository;
}

async function boundSession(apiOrigin: string, token: string, binding: Binding): Promise<Session> {
  let response: SessionEventsPage;
  try {
    response = await apiRequest(
      apiOrigin,
      token,
      `/v1/sessions/${binding.sessionId!}/events?limit=1`,
    );
  } catch {
    throw new Error(
      'The bound investigation could not be verified. Its configuration and local evidence were preserved.',
    );
  }
  if (
    !Check(SessionEventsPageSchema, response) ||
    response.session.id !== binding.sessionId ||
    response.session.repositoryId !== binding.repositoryId ||
    response.events.length > 1 ||
    response.page.returnedEvents !== response.events.length ||
    response.events.some(
      (event) =>
        event.sessionId !== binding.sessionId || event.repositoryId !== binding.repositoryId,
    ) ||
    response.memories.some(
      (memory) =>
        memory.sessionId !== binding.sessionId ||
        memory.repositoryId !== binding.repositoryId ||
        !response.events.some((event) => event.eventId === memory.id),
    )
  )
    throw new Error(
      'The API investigation response did not match the bound repository and session. No binding was changed.',
    );
  return response.session;
}

/** Repeated initialization verifies existing state; it never switches an investigation or reseeds an outbox. */
export async function initializeRepository(
  options: InitializationOptions = {},
  dependencies: { git?: typeof gitText } = {},
): Promise<InitializationResult> {
  if (options.repositoryId !== undefined && !Check(IdSchema, options.repositoryId))
    throw new Error('Provide a valid repository UUID before initializing.');
  const requestedApi = options.apiUrl ?? process.env['MEMVORA_API_URL'];
  const requestedOrigin = requestedApi === undefined ? undefined : origin(requestedApi);
  const cwd = resolve(options.cwd ?? process.cwd());
  const git = dependencies.git ?? gitText;
  const discovered = await git(cwd, ['rev-parse', '--show-toplevel']);
  const gitRoot =
    discovered.ok && discovered.text.trim() ? resolve(discovered.text.trim()) : undefined;
  const root = initializationRoot(cwd, gitRoot);
  const configuration = join(root, '.memvora', 'config.json');

  if (hasEntry(configuration)) {
    let binding: Binding;
    try {
      binding = readBinding(root);
    } catch {
      throw new Error(
        'An existing local binding could not be validated. Review it before retrying; no files were changed.',
      );
    }
    if (options.repositoryId !== undefined && options.repositoryId !== binding.repositoryId)
      throw new Error(
        'The requested repository differs from the existing binding. Initialization does not rebind or overwrite it.',
      );
    const existingOrigin = origin(binding.apiUrl);
    if (requestedOrigin !== undefined && requestedOrigin !== existingOrigin)
      throw new Error(
        'The requested API origin conflicts with the existing binding. No configuration was changed.',
      );
    const token = readToken(options.home);
    await repositoryById(existingOrigin, token, binding.repositoryId);
    const session = binding.sessionId ? await boundSession(existingOrigin, token, binding) : null;
    return { root, binding, mode: 'existing', sessionStatus: session?.status ?? null };
  }

  const privateDirectory = join(root, '.memvora');
  if (
    hasEntry(privateDirectory) &&
    (!lstatSync(privateDirectory).isDirectory() || lstatSync(privateDirectory).isSymbolicLink())
  )
    throw new Error(
      'New initialization requires a regular local .memvora directory. No configuration was created.',
    );
  const apiOrigin = requestedOrigin ?? 'http://127.0.0.1:4000';
  const token = readToken(options.home);
  let repository: Repository;
  if (options.repositoryId !== undefined) {
    repository = await repositoryById(apiOrigin, token, options.repositoryId);
  } else {
    const remote = await git(root, ['remote', 'get-url', 'origin']);
    let remoteUrl = remote.text.trim();
    if (/^https?:\/\//iu.test(remoteUrl)) {
      const safeRemote = new URL(remoteUrl);
      safeRemote.username = '';
      safeRemote.password = '';
      remoteUrl = safeRemote.toString();
    }
    let response: { repository: Repository };
    try {
      response = await apiRequest(apiOrigin, token, '/v1/repositories', {
        name: basename(root),
        localPath: root,
        ...(remote.ok && remoteUrl ? { remoteUrl } : {}),
      });
    } catch {
      throw new Error(
        'Repository registration could not be confirmed. No local binding was written.',
      );
    }
    if (!Check(RepositoryResponseSchema, response))
      throw new Error(
        'Repository registration failed the shared response contract. No local binding was written.',
      );
    repository = response.repository;
  }
  let response: { session: Session };
  try {
    response = await apiRequest(apiOrigin, token, '/v1/sessions', {
      repositoryId: repository.id,
      title: 'Initial investigation',
    });
  } catch {
    throw new Error(
      'Initial investigation creation could not be confirmed. No local binding was written.',
    );
  }
  if (
    !Check(SessionResponseSchema, response) ||
    response.session.repositoryId !== repository.id ||
    response.session.status !== 'open'
  )
    throw new Error(
      'The initial investigation response did not match the selected repository. No local binding was written.',
    );
  const binding: Binding = {
    schemaVersion: 1,
    repositoryId: repository.id,
    apiUrl: apiOrigin,
    sessionId: response.session.id,
  };
  ensurePrivateDirectory(privateDirectory);
  try {
    writeFileSync(configuration, `${JSON.stringify(binding, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    throw new Error(
      'The new binding could not be committed exclusively. No existing configuration was overwritten; any newly created partial file was retained.',
    );
  }
  return { root, binding, mode: 'created', sessionStatus: response.session.status };
}
