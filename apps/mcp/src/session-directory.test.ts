import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDirectoryPage } from '@memvora/contracts';
import { findSessions, SESSION_DIRECTORY_BYTE_LIMIT } from './session-directory.js';
import { toolResult } from './client.js';

const repositoryId = '11111111-1111-4111-8111-111111111111';

function page(limit = 5): SessionDirectoryPage {
  return {
    items: Array.from({ length: limit }, (_item, index) => ({
      id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
      repositoryId,
      title: `Old migration fixture ${index}`,
      titleTruncated: false,
      status: 'open',
      createdAt: `2020-01-${String(31 - index).padStart(2, '0')}T00:00:00.000Z`,
      closedAt: null,
      eventCount: 0,
      memoryCount: 0,
    })),
    filters: { query: '', repositoryId: null, status: 'all' },
    page: {
      limit,
      returnedItems: limit,
      totalMatching: 150,
      nextCursor: 'fixture-next-cursor',
      order: 'newest_created_first',
      consistency: 'live',
    },
  };
}

function environment(response: SessionDirectoryPage) {
  vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
  vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'private-local-directory-test-token-at-least-32-characters');
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('read-only MCP investigation finding', () => {
  it('defaults to five complete results and forwards exact normalized filters/cursor without following pages', async () => {
    const response = page();
    response.filters = { query: 'migration', repositoryId, status: 'open' };
    const fetcher = environment(response);
    const result = await findSessions({
      query: ' migration ',
      repositoryId,
      status: 'open',
      cursor: 'fixture-prior+/=cursor',
    });
    expect(result.items).toEqual(response.items);
    expect(result.page).toEqual(response.page);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4000/v1/sessions/search');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      query: 'migration',
      repositoryId,
      status: 'open',
      cursor: 'fixture-prior+/=cursor',
      limit: 5,
    });
    expect(result.evidenceNotice).toContain('titles only');
    expect(result.evidenceNotice).toContain('live directory');
  });

  it.each(['\u0000', '\\"', '界😀'])(
    'preserves ten original bounded titles and a maximum cursor under escaped %j pressure',
    async (character) => {
      const response = page(10);
      const title = character
        .repeat(200)
        .slice(0, 200)
        .replace(/[\uD800-\uDBFF]$/u, '');
      response.items = response.items.map((item) => ({ ...item, title }));
      response.page.nextCursor = character
        .repeat(2048)
        .slice(0, 2048)
        .replace(/[\uD800-\uDBFF]$/u, '');
      environment(response);
      const result = await findSessions({ limit: 10 });
      expect(result.items).toEqual(response.items);
      expect(result.filters).toEqual(response.filters);
      expect(result.page).toEqual(response.page);
      const encoded = await toolResult(async () => result);
      expect(encoded.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(encoded), 'utf8')).toBeLessThanOrEqual(
        SESSION_DIRECTORY_BYTE_LIMIT,
      );
      expect(JSON.stringify(encoded)).not.toMatch(
        /\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i,
      );
    },
  );

  it('fails closed on foreign members, wrong cardinality/order and unsupported request limits', async () => {
    const response = page(2);
    const fetcher = environment(response);
    await expect(findSessions({ limit: 11 })).rejects.toThrow('1 to 10');
    expect(fetcher).not.toHaveBeenCalled();
    for (const alter of [
      (value: SessionDirectoryPage) => {
        value.items.reverse();
      },
      (value: SessionDirectoryPage) => {
        value.page.returnedItems = 0;
      },
      (value: SessionDirectoryPage) => {
        value.filters.repositoryId = repositoryId;
      },
      (value: SessionDirectoryPage) => {
        value.items[1]!.id = value.items[0]!.id;
      },
    ]) {
      const invalid = page(2);
      alter(invalid);
      fetcher.mockImplementationOnce(async () => new Response(JSON.stringify(invalid)));
      const result = await toolResult(() => findSessions({ limit: 2 }));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(invalid.items[0]!.title);
    }
  });
});
