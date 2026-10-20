import { describe, expect, it } from 'vitest';
import type { RepositorySourceMatch } from '@memvora/contracts';
import { clipRepositorySourceMatch } from './source-excerpts.js';

function match(excerpt: string): RepositorySourceMatch {
  return {
    source: {
      id: '11111111-1111-4111-8111-111111111111',
      repositoryId: '22222222-2222-4222-8222-222222222222',
      fullName: 'fixture-owner/excerpt-fixture',
      path: 'src/fixture.ts',
      commitSha: null,
      blobSha: 'fixture-blob',
      contentHash: 'a'.repeat(64),
      importedAt: '2026-10-21T00:00:00Z',
      lineCount: 100,
      isCurrent: true,
    },
    startLine: 10,
    endLine: 10 + excerpt.split(/\r\n|\r|\n/u).length - 1,
    excerpt,
    excerptTruncated: false,
  };
}

describe('file excerpts across adapters', () => {
  it('keeps shortened CRLF excerpts and their cited stored line range aligned', () => {
    const original = match('first line\r\nsecond line\r\nthird line');
    const clipped = clipRepositorySourceMatch(original, 26);
    expect(clipped.excerpt).toBe('first line\r\nsecond line');
    expect(clipped).toMatchObject({ startLine: 10, endLine: 11, excerptTruncated: true });
    expect(clipped.source).toEqual(original.source);
    expect(original.endLine).toBe(12);
  });
  it('marks an incomplete single line and does not split a supplementary Unicode character', () => {
    const clipped = clipRepositorySourceMatch(match('abc😀long single line'), 4);
    expect(clipped.excerpt).toBe('abc');
    expect(clipped).toMatchObject({ startLine: 10, endLine: 10, excerptTruncated: true });
  });
});
