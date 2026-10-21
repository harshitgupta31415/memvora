import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionDirectoryPage } from '@memvora/contracts';
import {
  assertSessionDirectoryPage,
  prepareSessionDirectoryRequest,
  sessionTitleSearchKey,
} from './session-directory.js';

function fixture(): SessionDirectoryPage {
  return {
    items: [
      {
        id: randomUUID(),
        repositoryId: randomUUID(),
        title: 'Café migration 100%_literal',
        titleTruncated: false,
        status: 'open',
        createdAt: '2026-10-21T00:00:00.000Z',
        closedAt: null,
        eventCount: 0,
        memoryCount: 0,
      },
    ],
    filters: { query: '', repositoryId: null, status: 'all' },
    page: {
      limit: 20,
      returnedItems: 1,
      totalMatching: 1,
      nextCursor: null,
      order: 'newest_created_first',
      consistency: 'live',
    },
  };
}

describe('shared investigation directory boundary', () => {
  it('normalizes Unicode title filters and display controls without interpreting punctuation or SQL syntax', () => {
    expect(
      prepareSessionDirectoryRequest({ query: ' \u001b[31mCAFE\u0301 %_\u0000\u202e ' }),
    ).toEqual({ query: 'CAFÉ %_', limit: 20 });
    expect(sessionTitleSearchKey('CAFE\u0301')).toBe(sessionTitleSearchKey('Café'));
    expect(prepareSessionDirectoryRequest({ query: '" OR 1=1 --' }).query).toBe('" OR 1=1 --');
  });
  it('rejects malformed filters and normalization expansion before querying or displaying results', () => {
    for (const value of [
      null,
      [],
      { limit: 0 },
      { limit: 51 },
      { status: 'deleted' },
      { repositoryId: 'foreign' },
      { all: true },
      { cursor: '' },
      { query: '\u0344'.repeat(200) },
    ])
      expect(() => prepareSessionDirectoryRequest(value as never)).toThrow();
  });
  it('accepts a valid full-page response and disclosed title clipping without substituting a client filter', () => {
    const page = fixture();
    expect(() => assertSessionDirectoryPage(page)).not.toThrow();
    page.filters.query = 'hidden suffix';
    page.items[0]!.titleTruncated = true;
    expect(() => assertSessionDirectoryPage(page, { query: 'hidden suffix' })).not.toThrow();
    page.items[0]!.titleTruncated = false;
    expect(() => assertSessionDirectoryPage(page, { query: 'hidden suffix' })).toThrow(
      'requested scope',
    );
  });
  it('rejects changed scope, unmatched titles, contradictory page metadata, duplicates and wrong ordering', () => {
    for (const mutate of [
      (page: SessionDirectoryPage) => {
        page.filters.repositoryId = randomUUID();
      },
      (page: SessionDirectoryPage) => {
        page.page.limit = 10;
      },
      (page: SessionDirectoryPage) => {
        page.page.returnedItems = 2;
      },
      (page: SessionDirectoryPage) => {
        page.page.totalMatching = 0;
      },
      (page: SessionDirectoryPage) => {
        page.items.push(page.items[0]!);
        page.page.returnedItems = 2;
        page.page.totalMatching = 2;
      },
      (page: SessionDirectoryPage) => {
        page.items.push({
          ...page.items[0]!,
          id: randomUUID(),
          createdAt: '2026-10-22T00:00:00.000Z',
        });
        page.page.returnedItems = 2;
        page.page.totalMatching = 2;
      },
    ]) {
      const page = fixture();
      mutate(page);
      expect(() => assertSessionDirectoryPage(page)).toThrow('requested scope');
    }
    const page = fixture();
    const repositoryId = randomUUID();
    page.filters.repositoryId = repositoryId;
    expect(() => assertSessionDirectoryPage(page, { repositoryId })).toThrow('requested scope');
    page.filters.repositoryId = null;
    page.filters.status = 'closed';
    expect(() => assertSessionDirectoryPage(page, { status: 'closed' })).toThrow('requested scope');
  });
});
