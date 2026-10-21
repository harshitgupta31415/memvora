import { stripVTControlCharacters } from 'node:util';
import { Check } from 'typebox/value';
import {
  SessionDirectoryRequestSchema,
  normalizeSessionDirectoryQuery,
  sessionDirectoryPageMatchesRequest,
} from '@memvora/contracts';
import type { SessionDirectoryRequest, SessionDirectoryPage } from '@memvora/contracts';
import { DomainError } from './local-service.js';
export { sessionTitleSearchKey } from '@memvora/contracts';

export function prepareSessionDirectoryRequest(input: SessionDirectoryRequest = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    !Check(SessionDirectoryRequestSchema, input)
  )
    throw new DomainError(
      'INVALID_SESSION_FILTER',
      'Use a title of up to 200 characters, authorized repository, open/closed state and page size from 1 to 50.',
      400,
    );
  const query = normalizeSessionDirectoryQuery(stripVTControlCharacters(input.query ?? ''));
  if (query.length > 200)
    throw new DomainError(
      'INVALID_SESSION_FILTER',
      'The normalized title query exceeds 200 characters.',
      400,
    );
  return { ...input, query, limit: input.limit ?? 20 };
}

/** Shared response validation protects every adapter without inventing client-side filtering. */
export function assertSessionDirectoryPage(
  page: SessionDirectoryPage,
  input: SessionDirectoryRequest = {},
): void {
  if (!sessionDirectoryPageMatchesRequest(page, prepareSessionDirectoryRequest(input)))
    throw new DomainError(
      'INVALID_SESSION_DIRECTORY_PAGE',
      'The investigation directory response did not match the requested scope and page.',
      500,
    );
}
