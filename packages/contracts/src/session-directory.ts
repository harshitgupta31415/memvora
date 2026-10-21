import { Check } from 'typebox/value';
import { SessionDirectoryPageSchema, SessionDirectoryRequestSchema } from './local.js';
import type { SessionDirectoryPage, SessionDirectoryRequest } from './local.js';

export function sessionTitleSearchKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/** Terminal escape sequences are stripped by Node adapters before this browser-safe step. */
export function normalizeSessionDirectoryQuery(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim()
    .normalize('NFC');
}

/** Compare a complete API page with its prepared request; never filter or drop returned members. */
export function sessionDirectoryPageMatchesRequest(
  value: unknown,
  input: SessionDirectoryRequest = {},
): value is SessionDirectoryPage {
  if (!Check(SessionDirectoryRequestSchema, input) || !Check(SessionDirectoryPageSchema, value))
    return false;
  const page = value as SessionDirectoryPage;
  const query = normalizeSessionDirectoryQuery(input.query ?? '');
  const limit = input.limit ?? 20;
  if (
    page.filters.query !== query ||
    page.filters.repositoryId !== (input.repositoryId ?? null) ||
    page.filters.status !== (input.status ?? 'all') ||
    page.page.limit !== limit ||
    page.page.returnedItems !== page.items.length ||
    page.items.length > limit ||
    page.page.totalMatching < page.items.length ||
    new Set(page.items.map((item) => item.id)).size !== page.items.length ||
    (!page.items.length && page.page.nextCursor !== null)
  )
    return false;
  const key = sessionTitleSearchKey(query);
  return page.items.every((item, index) => {
    const time = new Date(item.createdAt);
    const previous = page.items[index - 1];
    return (
      Number.isFinite(time.getTime()) &&
      time.toISOString() === item.createdAt &&
      (!input.repositoryId || item.repositoryId === input.repositoryId) &&
      (!input.status || item.status === input.status) &&
      (!key || item.titleTruncated || sessionTitleSearchKey(item.title).includes(key)) &&
      (!previous ||
        item.createdAt < previous.createdAt ||
        (item.createdAt === previous.createdAt && item.id < previous.id))
    );
  });
}
