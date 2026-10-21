import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionNote, SessionNoteCitation } from '@memvora/contracts';
import {
  collectNoteEvent,
  formatRecallCitation,
  prepareSessionNote,
  readSessionNotes,
  sessionNotesQuery,
  submitSessionNote,
} from './session-notes.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const noteId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const repositoryId = '44444444-4444-4444-8444-444444444444';
const token = 'private-local-journal-test-token-at-least-32-characters';
const body = 'Explicit user-authored fixture claim, not a verified fix.';

function note(): SessionNote {
  return {
    id: noteId,
    sessionId,
    repositoryId,
    kind: 'decision',
    body,
    author: { id: '55555555-5555-4555-8555-555555555555', name: 'Fixture author' },
    createdAt: '2026-10-21T09:00:00.000Z',
    label: 'User-authored — not independently verified',
    sources: [{ id: eventId, repositoryId, kind: 'event', locator: `/v1/events/${eventId}` }],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('CLI session journal', () => {
  it('collects repeated event arguments and creates one stable retry identity', () => {
    const generate = vi.fn(() => noteId);
    const events = collectNoteEvent(eventId, []);
    const input = prepareSessionNote({ text: body, kind: 'decision', event: events }, generate);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(input).toEqual({ id: noteId, kind: 'decision', body, eventIds: [eventId] });
    expect(
      prepareSessionNote({ text: body, kind: 'decision', event: events, noteId }, generate),
    ).toEqual(input);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(prepareSessionNote({ text: body, noteId }).eventIds).toEqual([]);
  });

  it('rejects bad kinds, empty/overlong text, duplicate sources and malformed navigation without echoing text', () => {
    for (const options of [
      { text: body, kind: 'verified', noteId },
      { text: ' ', noteId },
      { text: body.repeat(100), noteId },
      { text: body, event: [eventId, eventId], noteId },
      { text: body, event: ['not-a-uuid'], noteId },
      { text: body, noteId: '../private' },
    ]) {
      try {
        prepareSessionNote(options);
        throw new Error('Expected invalid journal arguments to be rejected.');
      } catch (error) {
        expect(String(error)).toContain('Use --text');
        expect(String(error)).not.toContain(body);
      }
    }
    expect(() => sessionNotesQuery('0')).toThrow('1 to 50');
    expect(() => sessionNotesQuery('51')).toThrow('1 to 50');
    expect(() => sessionNotesQuery('1.5')).toThrow('1 to 50');
    expect(() => sessionNotesQuery('20', '../private')).toThrow('UUID');
  });

  it('reports only the retry UUID after failure and resends the exact request on explicit retry', async () => {
    const input = prepareSessionNote({ text: body, kind: 'decision', event: [eventId], noteId });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: `Remote fixture echoed: ${body} ${token}` } }),
          { status: 500 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ note: note() }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const failure = await submitSessionNote('http://127.0.0.1:4000', token, sessionId, input).catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(`--note-id ${noteId}`);
    expect(String(failure)).not.toContain(body);
    expect(String(failure)).not.toContain(token);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      submitSessionNote('http://127.0.0.1:4000', token, sessionId, input),
    ).resolves.toEqual({ note: note() });
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe(`http://127.0.0.1:4000/v1/sessions/${sessionId}/notes`);
      expect(init).toEqual(expect.objectContaining({ method: 'POST', redirect: 'error' }));
      expect(JSON.parse(String(init?.body))).toEqual(input);
    }
  });

  it('validates page responses and labels journal citations independently of observed evidence', async () => {
    const page = { sessionId, totalNotes: 4, items: [note()], olderBeforeId: noteId };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page)));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      readSessionNotes('http://127.0.0.1:4000', token, sessionId, sessionNotesQuery('1', noteId)),
    ).resolves.toEqual(page);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/sessions/${sessionId}/notes?limit=1&before=${noteId}`,
    );
    fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...page, items: [{ ...note(), label: 'Observed' }] })),
    );
    await expect(
      readSessionNotes('http://127.0.0.1:4000', token, sessionId, { limit: 1 }),
    ).rejects.toThrow('shared runtime contract');
    const citation: SessionNoteCitation = {
      id: noteId,
      kind: 'session_note',
      repositoryId,
      sessionId,
      locator: `/v1/session-notes/${noteId}`,
      authorName: 'Fixture author',
      createdAt: note().createdAt,
      noteKind: 'decision',
    };
    expect(formatRecallCitation(citation)).toContain('User-authored decision by Fixture author');
    expect(formatRecallCitation(citation)).toContain('not independently verified');
    expect(formatRecallCitation(citation)).toContain(citation.locator);
  });
});
