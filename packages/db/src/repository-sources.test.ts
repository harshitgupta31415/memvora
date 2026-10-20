import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryContext } from '@memvora/contracts';
import { SqliteEvidenceStore } from './sqlite-store.js';

const stores: SqliteEvidenceStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !/^memvora-source-(cap|upgrade|purge|generation)-/u.test(basename(target))
    )
      throw new Error('Unexpected source test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
const open = (path = ':memory:') => {
  const store = new SqliteEvidenceStore(path);
  stores.push(store);
  return store;
};
function fixture(path = ':memory:') {
  const store = open(path);
  const context = store.context();
  const repository = store.createRepository(context, { name: 'Source snapshots' });
  const imported = (text: string, commitSha: string | null = null): RepositoryContext => ({
    provider: 'github',
    fullName: 'owner/source-snapshots',
    defaultBranch: 'main',
    commitSha,
    importedAt: '2026-10-21T10:00:00.000Z',
    partial: true,
    files: [{ path: 'src/service.ts', sha: 'a'.repeat(40), size: Buffer.byteLength(text), text }],
    issues: [],
    pullRequests: [],
  });
  const sourceId = () => store.getRepositoryContext(context, repository.id)!.files[0]!.sourceId!;
  return { store, context, repository, imported, sourceId };
}

describe('immutable repository source storage', () => {
  it('keeps stable nullable-commit identities, versions changed snapshots, and indexes only current heads', () => {
    const { store, context, repository, imported, sourceId } = fixture();
    const first = imported('export const stableNeedle = 1;');
    store.saveRepositoryContext(context, repository.id, first);
    const firstId = sourceId();
    store.saveRepositoryContext(context, repository.id, {
      ...first,
      importedAt: '2026-10-21T11:00:00.000Z',
    });
    expect(sourceId()).toBe(firstId);
    expect(store.getRepositorySource(context, firstId).source).toMatchObject({
      commitSha: null,
      importedAt: first.importedAt,
      isCurrent: true,
      contentHash: createHash('sha256').update(first.files[0]!.text).digest('hex'),
    });
    store.saveRepositoryContext(
      context,
      repository.id,
      imported('export const changedNeedle = 2;'),
    );
    const secondId = sourceId();
    expect(secondId).not.toBe(firstId);
    expect(store.searchRepositorySources(context, { query: 'stableNeedle' })).toEqual([]);
    expect(
      store
        .searchRepositorySources(context, { query: 'changedNeedle' })
        .map((match) => match.source.id),
    ).toEqual([secondId]);
    expect(store.getRepositorySource(context, firstId)).toMatchObject({
      source: { isCurrent: false },
      excerpt: first.files[0]!.text,
    });
    store.saveRepositoryContext(
      context,
      repository.id,
      imported('export const changedNeedle = 2;', 'b'.repeat(40)),
    );
    expect(sourceId()).not.toBe(secondId);
    expect(store.getRepositorySource(context, secondId).source.isCurrent).toBe(false);
    expect(() => store.searchRepositorySources(context, { query: '" OR * : % ( )' })).not.toThrow();
  });

  it('enforces snapshot line ranges and UTF-8 excerpt bounds after defensive redaction', () => {
    const { store, context, repository, imported, sourceId } = fixture();
    const raw =
      'first line\n{"password":"secret with spaces"}\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nlast line';
    store.saveRepositoryContext(context, repository.id, imported(raw));
    const document = store.getRepositorySource(context, sourceId(), { startLine: 2, limit: 2 });
    expect(document).toMatchObject({
      startLine: 2,
      endLine: 3,
      source: { lineCount: 4 },
      hasBefore: true,
      hasAfter: true,
    });
    expect(document.excerpt).not.toContain('secret with spaces');
    expect(document.excerpt).not.toContain('private-material');
    expect(() => store.getRepositorySource(context, sourceId(), { startLine: 5 })).toThrow();
    expect(() => store.getRepositorySource(context, sourceId(), { limit: 201 })).toThrow();
    store.saveRepositoryContext(context, repository.id, imported('😀'.repeat(5000)));
    const bounded = store.getRepositorySource(context, sourceId());
    expect(Buffer.byteLength(bounded.excerpt, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(bounded.excerpt.length).toBeLessThanOrEqual(16_000);
    expect(bounded.excerpt).not.toContain('\uFFFD');
    expect(bounded.excerptTruncated).toBe(true);
    store.saveRepositoryContext(context, repository.id, imported(''));
    expect(store.getRepositorySource(context, sourceId())).toMatchObject({
      source: { lineCount: 1 },
      startLine: 1,
      endLine: 1,
      excerpt: '',
      hasBefore: false,
      hasAfter: false,
    });
  });

  it('finds a literal code token at its stored snapshot lines', () => {
    const { store, context, repository, imported } = fixture();
    const lines = Array.from({ length: 50 }, (_value, index) =>
      index === 29 ? 'export function sourceSpecificNeedle() {}' : `// filler line ${index + 1}`,
    );
    store.saveRepositoryContext(context, repository.id, imported(lines.join('\r\n')));
    const match = store.searchRepositorySources(context, { query: 'sourceSpecificNeedle()' })[0];
    expect(match).toMatchObject({
      startLine: 27,
      endLine: 38,
      source: { lineCount: 50, isCurrent: true },
    });
    expect(match?.excerpt).toContain('sourceSpecificNeedle');
  });

  it('rejects invalid or oversized imports without changing context, current pointers, or search', () => {
    const { store, context, repository, imported, sourceId } = fixture();
    const original = imported('export const preservedPointer = true;');
    store.saveRepositoryContext(context, repository.id, original);
    const beforeId = sourceId();
    expect(() =>
      store.saveRepositoryContext(context, repository.id, {
        ...original,
        files: [original.files[0]!, original.files[0]!],
      }),
    ).toThrow();
    const oversized = {
      ...original,
      files: Array.from({ length: 100 }, (_value, index) => ({
        ...original.files[0]!,
        path: `file-${index}.ts`,
        text: 'x'.repeat(24_576),
      })),
    };
    expect(() => store.saveRepositoryContext(context, repository.id, oversized)).toThrow(/2 MiB/);
    expect(sourceId()).toBe(beforeId);
    expect(store.getRepositoryContext(context, repository.id)?.files[0]?.text).toBe(
      original.files[0]?.text,
    );
    expect(store.searchRepositorySources(context, { query: 'preservedPointer' })).toHaveLength(1);
  });

  it('fails an import at the retained history cap without evicting or replacing prior sources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-source-cap-'));
    directories.push(directory);
    const { store, context, repository, imported, sourceId } = fixture(
      join(directory, 'server.sqlite'),
    );
    const original = imported('export const retainedHistoryNeedle = true;');
    store.saveRepositoryContext(context, repository.id, original);
    const firstId = sourceId();
    const connection = new DatabaseSync(store.path);
    try {
      connection
        .prepare(
          `WITH RECURSIVE versions(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM versions WHERE n<1999) INSERT INTO local_repository_sources(id,workspace_id,repository_id,workspace_generation,repository_generation,full_name,path,commit_sha,commit_key,blob_sha,content_hash,text,line_count,imported_at) SELECT printf('%08x-0000-4000-8000-%012x',n,n),s.workspace_id,s.repository_id,s.workspace_generation,s.repository_generation,s.full_name,'history-' || n || '.ts',s.commit_sha,s.commit_key,s.blob_sha,?,'',1,s.imported_at FROM local_repository_sources s CROSS JOIN versions WHERE s.id=?`,
        )
        .run(createHash('sha256').update('').digest('hex'), firstId);
      expect(() =>
        connection
          .prepare("UPDATE local_repository_sources SET text='mutated' WHERE id=?")
          .run(firstId),
      ).toThrow(/IMMUTABLE/);
    } finally {
      connection.close();
    }
    expect(() =>
      store.saveRepositoryContext(
        context,
        repository.id,
        imported('export const rejectedNewVersion = true;'),
      ),
    ).toThrow(/history limit/);
    expect(sourceId()).toBe(firstId);
    expect(store.searchRepositorySources(context, { query: 'retainedHistoryNeedle' })).toHaveLength(
      1,
    );
    expect(store.searchRepositorySources(context, { query: 'rejectedNewVersion' })).toEqual([]);
    expect(() => store.saveRepositoryContext(context, repository.id, original)).not.toThrow();
  });

  it('backfills a version-3 context once and keeps stable source citations across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-source-upgrade-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const previous = fixture(path);
    const repositoryId = previous.repository.id;
    previous.store.saveRepositoryContext(
      previous.context,
      repositoryId,
      previous.imported('export const legacyContextNeedle = true;'),
    );
    previous.store.close();
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(
        'BEGIN IMMEDIATE; DROP TABLE local_repository_source_heads; DROP TABLE local_repository_sources; DROP TABLE local_repository_source_fts; PRAGMA user_version=3; COMMIT;',
      );
    } finally {
      legacy.close();
    }
    const upgraded = open(path);
    const hit = upgraded.searchRepositorySources(upgraded.context(), {
      query: 'legacyContextNeedle',
    })[0];
    expect(hit?.source.isCurrent).toBe(true);
    const id = hit!.source.id;
    expect(
      upgraded.getRepositoryContext(upgraded.context(), repositoryId)?.files[0]?.sourceId,
    ).toBe(id);
    upgraded.close();
    const reopened = open(path);
    expect(
      reopened
        .searchRepositorySources(reopened.context(), { query: 'legacyContextNeedle' })
        .map((match) => match.source.id),
    ).toEqual([id]);
  });

  it('physically purges every file version and its current index membership on repository deletion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-source-purge-'));
    directories.push(directory);
    const { store, context, repository, imported, sourceId } = fixture(
      join(directory, 'server.sqlite'),
    );
    store.saveRepositoryContext(
      context,
      repository.id,
      imported('export const firstPurgeNeedle = true;'),
    );
    const oldId = sourceId();
    store.saveRepositoryContext(
      context,
      repository.id,
      imported('export const secondPurgeNeedle = true;'),
    );
    store.deleteRepository(context, repository.id);
    expect(() => store.getRepositorySource(context, oldId)).toThrow();
    const connection = new DatabaseSync(store.path);
    try {
      for (const table of [
        'local_repository_sources',
        'local_repository_source_heads',
        'local_repository_source_fts',
      ])
        expect(connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.['count']).toBe(
          0,
        );
    } finally {
      connection.close();
    }
  });

  it('creates a fresh version for a new verified scope generation and keeps the prior generation fenced', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-source-generation-'));
    directories.push(directory);
    const { store, context, repository, imported, sourceId } = fixture(
      join(directory, 'server.sqlite'),
    );
    const snapshot = imported('export const renewedScopeNeedle = true;');
    store.saveRepositoryContext(context, repository.id, snapshot);
    const oldId = sourceId();
    const expectedGeneration = store.repositoryGeneration(context, repository.id);
    const connection = new DatabaseSync(store.path);
    try {
      connection
        .prepare('UPDATE local_repositories SET generation=generation+1 WHERE id=?')
        .run(repository.id);
    } finally {
      connection.close();
    }
    expect(() => store.getRepositorySource(context, oldId)).toThrow();
    expect(store.getRepositoryContext(context, repository.id)).toBeNull();
    expect(store.searchRepositorySources(context, { query: 'renewedScopeNeedle' })).toEqual([]);
    expect(() =>
      store.saveRepositoryContext(context, repository.id, snapshot, expectedGeneration),
    ).toThrow();
    expect(store.getRepositoryContext(context, repository.id)).toBeNull();
    store.saveRepositoryContext(
      context,
      repository.id,
      snapshot,
      store.repositoryGeneration(context, repository.id),
    );
    const newId = sourceId();
    expect(newId).not.toBe(oldId);
    expect(
      store
        .searchRepositorySources(context, { query: 'renewedScopeNeedle' })
        .map((match) => match.source.id),
    ).toEqual([newId]);
    expect(() => store.getRepositorySource(context, oldId)).toThrow();
  });
});
