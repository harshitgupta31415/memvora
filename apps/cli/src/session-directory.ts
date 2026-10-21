import {
  IdSchema,
  SessionDirectoryRequestSchema,
  type SessionDirectoryPage,
  type SessionDirectoryRequest,
} from '@memvora/contracts';
import { assertSessionDirectoryPage, prepareSessionDirectoryRequest } from '@memvora/core';
import { Check } from 'typebox/value';
import { apiRequest, findBindingDirectory, readBinding, type Binding } from './local.js';

export type SessionListOptions = {
  query?: string;
  repository?: string;
  allRepositories?: boolean;
  status?: string;
  limit?: string;
  cursor?: string;
};

function currentBinding(): Binding | undefined {
  const directory = findBindingDirectory();
  return directory ? readBinding(directory) : undefined;
}

/** Explicit scope never consults potentially unrelated or corrupt cwd configuration. */
export function resolveSessionDirectoryRequest(
  options: SessionListOptions,
  loadBinding: () => Binding | undefined = currentBinding,
): { input: SessionDirectoryRequest; binding?: Binding } {
  if (options.repository !== undefined && options.allRepositories)
    throw new Error('Choose --repository or --all-repositories, not both.');
  if (options.repository !== undefined && !Check(IdSchema, options.repository))
    throw new Error('Provide a valid repository UUID.');
  const limit = options.limit ?? '20';
  const candidate = {
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.repository === undefined ? {} : { repositoryId: options.repository }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: /^\d+$/u.test(limit) ? Number(limit) : Number.NaN,
  };
  if (!Check(SessionDirectoryRequestSchema, candidate))
    throw new Error(
      'Use a title query of up to 200 characters, open/closed status, a limit from 1 to 50 and a nonempty cursor of up to 2048 characters.',
    );
  const prepared = prepareSessionDirectoryRequest(candidate);
  const binding =
    options.repository !== undefined || options.allRepositories ? undefined : loadBinding();
  const input = prepareSessionDirectoryRequest({
    ...prepared,
    ...(binding ? { repositoryId: binding.repositoryId } : {}),
  });
  return { input, ...(binding ? { binding } : {}) };
}

export async function readSessionDirectory(
  origin: string,
  token: string,
  input: SessionDirectoryRequest,
): Promise<SessionDirectoryPage> {
  const prepared = prepareSessionDirectoryRequest(input);
  const page = await apiRequest<SessionDirectoryPage>(
    origin,
    token,
    '/v1/sessions/search',
    prepared,
  );
  assertSessionDirectoryPage(page, prepared);
  return page;
}
