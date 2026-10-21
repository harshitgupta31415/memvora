import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDirectoryPage } from '@memvora/contracts';
import { readSessionDirectory, resolveSessionDirectoryRequest } from './session-directory.js';

const repositoryId = '11111111-1111-4111-8111-111111111111';
const token = 'private-local-directory-test-token-at-least-32-characters';
const binding = { schemaVersion: 1 as const, repositoryId, apiUrl: 'http://127.0.0.1:4999' };

function page(): SessionDirectoryPage {
  return {
    items: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        repositoryId,
        title: 'Old migration investigation fixture',
        titleTruncated: false,
        status: 'closed',
        createdAt: '2020-01-01T00:00:00.000Z',
        closedAt: '2020-01-02T00:00:00.000Z',
        eventCount: 0,
        memoryCount: 0,
      },
    ],
    filters: { query: 'migration', repositoryId, status: 'closed' },
    page: {
      limit: 1,
      returnedItems: 1,
      totalMatching: 125,
      nextCursor: 'fixture-next-cursor',
      order: 'newest_created_first',
      consistency: 'live',
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('CLI investigation directory', () => {
  it('uses the current binding by default and bypasses it completely for explicit scope', () => {
    const load = vi.fn(() => binding);
    expect(resolveSessionDirectoryRequest({ query: ' migration ' }, load)).toEqual({
      input: { query: 'migration', limit: 20, repositoryId },
      binding,
    });
    const broken = vi.fn(() => {
      throw new Error('Unrelated corrupt cwd binding');
    });
    expect(resolveSessionDirectoryRequest({ repository: repositoryId }, broken)).toEqual({
      input: { query: '', limit: 20, repositoryId },
    });
    expect(resolveSessionDirectoryRequest({ allRepositories: true }, broken)).toEqual({
      input: { query: '', limit: 20 },
    });
    expect(broken).not.toHaveBeenCalled();
    expect(resolveSessionDirectoryRequest({}, () => undefined)).toEqual({
      input: { query: '', limit: 20 },
    });
    expect(() => resolveSessionDirectoryRequest({}, broken)).toThrow('corrupt cwd');
  });

  it('rejects contradictory scope and invalid filters without loading configuration', () => {
    const load = vi.fn(() => binding);
    for (const options of [
      { repository: repositoryId, allRepositories: true },
      { repository: '../private' },
      { status: 'resolved' },
      { limit: '51' },
      { limit: '1.5' },
      { cursor: '' },
      { cursor: 'x'.repeat(2049) },
      { query: 'x'.repeat(201) },
      { query: '\u0344'.repeat(200) },
    ])
      expect(() => resolveSessionDirectoryRequest(options, load)).toThrow();
    expect(load).not.toHaveBeenCalled();
  });

  it('forwards filters and the opaque cursor once and returns an older session without local cutoff filtering', async () => {
    const response = page();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetcher);
    const input = {
      query: ' migration ',
      repositoryId,
      status: 'closed' as const,
      limit: 1,
      cursor: 'fixture-prior+/=cursor',
    };
    await expect(readSessionDirectory('http://127.0.0.1:4000', token, input)).resolves.toEqual(
      response,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4000/v1/sessions/search');
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      ...input,
      query: 'migration',
    });
  });

  it('uses shared response validation and preserves an explicitly shortened matching title', async () => {
    const input = { query: 'migration', repositoryId, status: 'closed' as const, limit: 1 };
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const truncated = page();
    truncated.items[0]!.title = 'x'.repeat(200);
    truncated.items[0]!.titleTruncated = true;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(truncated)));
    await expect(readSessionDirectory('http://127.0.0.1:4000', token, input)).resolves.toEqual(
      truncated,
    );
    for (const alter of [
      (value: SessionDirectoryPage) => {
        value.filters.repositoryId = null;
      },
      (value: SessionDirectoryPage) => {
        value.items[0]!.repositoryId = '33333333-3333-4333-8333-333333333333';
      },
      (value: SessionDirectoryPage) => {
        value.page.returnedItems = 0;
      },
      (value: SessionDirectoryPage) => {
        value.items[0]!.title = 'Unrelated title';
      },
    ]) {
      const invalid = page();
      alter(invalid);
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(invalid)));
      await expect(readSessionDirectory('http://127.0.0.1:4000', token, input)).rejects.toThrow(
        'requested scope and page',
      );
    }
  });
});
