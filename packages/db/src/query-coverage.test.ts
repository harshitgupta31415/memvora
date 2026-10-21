import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { prepareEvents } from '@memvora/core';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture(text = 'RareCoverageIdentifier927') {
  const store = new SqliteEvidenceStore(':memory:');
  stores.push(store);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Synthetic query coverage' });
  const session = store.createSession(context, { repositoryId: repository.id });
  const event: CapturedEvent = {
    eventId: randomUUID(),
    repositoryId: repository.id,
    sessionId: session.id,
    sequence: 1,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:01.000Z',
    command: { executable: 'node', args: ['fixture.js'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [{ ordinal: 0, stream: 'stderr', text }],
    diffs: [],
  };
  store.ingest(context, prepareEvents([event]));
  const { note } = store.createSessionNote(context, session.id, {
    id: randomUUID(),
    kind: 'note',
    body: text,
    eventIds: [],
  });
  store.saveRepositoryContext(context, repository.id, {
    provider: 'github',
    fullName: 'synthetic/coverage',
    defaultBranch: 'main',
    commitSha: null,
    importedAt: '2026-10-21T10:00:00.000Z',
    files: [
      {
        path: 'src/coverage.ts',
        sha: 'synthetic-blob',
        size: Buffer.byteLength(text, 'utf8'),
        text,
      },
    ],
    issues: [],
    pullRequests: [],
  });
  const source = store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId!;
  const readers = {
    commands: (query: string) =>
      store.search(context, { query, repositoryIds: [repository.id] }).map((memory) => memory.id),
    notes: (query: string) =>
      store
        .searchSessionNotes(context, { query, repositoryIds: [repository.id] }, session.id)
        .map((item) => item.id),
    files: (query: string) =>
      store
        .searchRepositorySources(context, { query, repositoryIds: [repository.id] })
        .map((item) => item.source.id),
  };
  return { readers, ids: { commands: event.eventId, notes: note.id, files: source } };
}
const corpora = ['commands', 'notes', 'files'] as const;

describe('consistent bounded literal query coverage', () => {
  it.each(corpora)('retains the useful late identifier in a natural question for %s', (corpus) => {
    const { readers, ids } = fixture();
    const question =
      'Please describe previous debugging attempts involving application startup networking configuration compatibility validation recovery observations verification diagnostics yesterday eventually RareCoverageIdentifier927';
    expect(readers[corpus](question)).toEqual([ids[corpus]]);
  });

  it('keeps exactly64 distinct useful literals and makes the bounded tail omission explicit in behavior', () => {
    const { readers, ids } = fixture();
    const fillers = Array.from({ length: 64 }, (_, index) => `unrecordedword${index}`);
    for (const corpus of corpora) {
      expect(
        readers[corpus]([...fillers.slice(0, 63), 'RareCoverageIdentifier927'].join(' ')),
      ).toEqual([ids[corpus]]);
      expect(readers[corpus]([...fillers, 'RareCoverageIdentifier927'].join(' '))).toEqual([]);
      const repeated = [
        ...Array.from({ length: 40 }, () => fillers[0]!),
        ...fillers.slice(1, 63),
        'RareCoverageIdentifier927',
      ];
      expect(readers[corpus](repeated.join(' '))).toEqual([ids[corpus]]);
    }
  });

  it('preserves literal punctuation and prevents query operators from widening any corpus', () => {
    const { readers, ids } = fixture('EADDRINUSE: synthetic endpoint');
    for (const corpus of corpora) {
      expect(readers[corpus]('How did we fix EADDRINUSE:')).toEqual([ids[corpus]]);
      expect(readers[corpus]('" OR * % : ( )')).toEqual([]);
      expect(readers[corpus]('not_recorded_unique_identifier')).toEqual([]);
    }
  });

  it('rejects empty, oversized and non-text queries consistently before FTS execution', () => {
    const { readers } = fixture();
    for (const corpus of corpora)
      for (const query of ['', '   ', 'x'.repeat(2001), null as unknown as string])
        expect(() => readers[corpus](query)).toThrow(
          expect.objectContaining({ code: 'INVALID_QUERY' }),
        );
  });
});
