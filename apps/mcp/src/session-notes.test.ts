import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionNoteResponseSchema,
  SessionNotesPageSchema,
  type SessionNote,
  type SessionNotesPage,
} from '@memvora/contracts';
import { Check } from 'typebox/value';
import { request, toolResult } from './client.js';
import { buildSessionNotesResult, SESSION_NOTES_BYTE_LIMIT } from './session-notes.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';

function page(): SessionNotesPage {
  const items: SessionNote[] = Array.from({ length: 10 }, (_item, index) => ({
    id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    repositoryId,
    sessionId,
    kind: index % 2 ? 'resolution' : 'decision',
    body: 'Explicit journal test fixture; a user claim, not a verified observation.',
    author: { id: '44444444-4444-4444-8444-444444444444', name: 'Fixture author' },
    createdAt: '2026-10-21T09:00:00.000Z',
    label: 'User-authored — not independently verified',
    sources: Array.from({ length: 10 }, (_source, ordinal) => {
      const id = `55555555-5555-4555-8555-${String(ordinal).padStart(12, '0')}`;
      return { id, repositoryId, kind: 'event', locator: `/v1/events/${id}` };
    }),
  }));
  return { sessionId, totalNotes: 50, items, olderBeforeId: items[0]!.id };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('read-only MCP journal projection', () => {
  it.each(['\u0000', '\\"', '界😀'])(
    'retains every page member and event citation under escaped %j body pressure',
    async (character) => {
      const input = page();
      const body = character
        .repeat(4000)
        .slice(0, 4000)
        .replace(/[\uD800-\uDBFF]$/u, '');
      input.items = input.items.map((note) => ({
        ...note,
        body,
        author: { ...note.author, name: '\u0000'.repeat(100) },
      }));
      expect(Check(SessionNotesPageSchema, input)).toBe(true);
      const result = buildSessionNotesResult(input);
      if (
        !('items' in result) ||
        !('olderBeforeId' in result) ||
        !('totalNotes' in result) ||
        !('sessionId' in result)
      )
        throw new Error('Expected a journal page projection.');
      expect(result.items.map((note) => note.id)).toEqual(input.items.map((note) => note.id));
      expect(result.olderBeforeId).toBe(input.olderBeforeId);
      expect(result.totalNotes).toBe(input.totalNotes);
      expect(result.sessionId).toBe(sessionId);
      expect(result.excerpted).toBe(true);
      for (const [index, note] of result.items.entries()) {
        const original = input.items[index]!;
        expect(note.sources).toEqual(original.sources);
        expect(note.author).toEqual(original.author);
        expect(note.kind).toBe(original.kind);
        expect(note.label).toBe('User-authored — not independently verified');
        expect(note.createdAt).toBe(original.createdAt);
        expect(note.bodyExcerpted).toBe(true);
      }
      const response = await toolResult(async () => result);
      expect(response.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(
        SESSION_NOTES_BYTE_LIMIT,
      );
      expect(JSON.stringify(response)).not.toMatch(
        /\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i,
      );
      expect(result.evidenceNotice).toContain('A resolution note does not prove a fix');
      expect(input.items[0]!.body).toBe(body);
      expect(buildSessionNotesResult(input)).toEqual(result);
    },
  );

  it('keeps ordinary detail/search text and rejects mismatched repository/session provenance', () => {
    const input = page();
    const note = input.items[0]!;
    const detail = buildSessionNotesResult({ note });
    if (!('note' in detail)) throw new Error('Expected journal detail.');
    expect(detail.note.body).toBe(note.body);
    expect(detail.note.bodyExcerpted).toBe(false);
    const search = buildSessionNotesResult({ items: [note], requestId: 'fixture-request' });
    expect(search).toMatchObject({ requestId: 'fixture-request', items: [{ id: note.id }] });
    const inconsistent = structuredClone(note);
    inconsistent.sources[0]!.repositoryId = '66666666-6666-4666-8666-666666666666';
    expect(() => buildSessionNotesResult({ note: inconsistent })).toThrow('repository evidence');
    const outside = page();
    outside.items[0]!.sessionId = '66666666-6666-4666-8666-666666666666';
    expect(() => buildSessionNotesResult(outside)).toThrow('outside the requested session');
  });

  it('validates the API boundary and returns no body when the user-authored label is lost', async () => {
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'private-local-journal-test-token-at-least-32-characters');
    const note = page().items[0]!;
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ note: { ...note, label: 'Observed' } })),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await toolResult(() =>
      request(`/v1/session-notes/${note.id}`, SessionNoteResponseSchema),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(note.body);
    expect(JSON.stringify(result)).not.toContain(note.id);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });
});
