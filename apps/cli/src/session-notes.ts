import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  CreateSessionNoteSchema,
  IdSchema,
  SessionNoteResponseSchema,
  SessionNotesPageSchema,
  SessionNotesQuerySchema,
  type CreateSessionNote,
  type RecallCitation,
  type SessionNote,
  type SessionNotesPage,
  type SessionNotesQuery,
} from '@memvora/contracts';
import { Check } from 'typebox/value';
import { apiRequest } from './local.js';

export type NoteOptions = { text?: string; kind?: string; event?: string[]; noteId?: string };

export function collectNoteEvent(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Generate one identity for the attempt; an explicit retry keeps that exact identity. */
export function prepareSessionNote(
  options: NoteOptions,
  generateId: () => string = randomUUID,
): CreateSessionNote {
  const input = {
    id: options.noteId ?? generateId(),
    kind: options.kind ?? 'note',
    body: options.text ?? '',
    eventIds: options.event ?? [],
  };
  if (!Check(CreateSessionNoteSchema, input) || !input.body.trim())
    throw new Error(
      'Use --text with 1–4000 characters, --kind note|decision|resolution, at most ten unique --event UUIDs and an optional UUID --note-id.',
    );
  return input;
}

export function noteRetryError(noteId: string): Error {
  return new Error(
    `Note submission was not confirmed. Retry the same text, kind and event IDs with --note-id ${noteId}. No automatic retry was performed.`,
  );
}

export async function submitSessionNote(
  origin: string,
  token: string,
  sessionId: string,
  input: CreateSessionNote,
): Promise<{ note: SessionNote }> {
  if (!Check(IdSchema, sessionId) || !Check(CreateSessionNoteSchema, input))
    throw new Error('A valid session UUID and journal-note request are required.');
  try {
    const response = await apiRequest<{ note: SessionNote }>(
      origin,
      token,
      `/v1/sessions/${sessionId}/notes`,
      input,
    );
    if (
      !Check(SessionNoteResponseSchema, response) ||
      response.note.id !== input.id ||
      response.note.sessionId !== sessionId
    )
      throw new Error('Unexpected note response.');
    return response;
  } catch {
    // Remote error text can include submitted text; only the stable retry key reaches stderr.
    throw noteRetryError(input.id);
  }
}

export function sessionNotesQuery(limit = '20', before?: string): SessionNotesQuery {
  const query = {
    limit: /^\d+$/.test(limit) ? Number(limit) : Number.NaN,
    ...(before === undefined ? {} : { before }),
  };
  if (!Check(SessionNotesQuerySchema, query))
    throw new Error('Use a note limit from 1 to 50 and an optional UUID --before.');
  return query;
}

export async function readSessionNotes(
  origin: string,
  token: string,
  sessionId: string,
  query: SessionNotesQuery,
): Promise<SessionNotesPage> {
  if (!Check(IdSchema, sessionId) || !Check(SessionNotesQuerySchema, query))
    throw new Error('A valid session UUID and journal page query are required.');
  const params = new URLSearchParams({ limit: String(query.limit ?? 20) });
  if (query.before) params.set('before', query.before);
  const result = await apiRequest<SessionNotesPage>(
    origin,
    token,
    `/v1/sessions/${sessionId}/notes?${params}`,
  );
  if (
    !Check(SessionNotesPageSchema, result) ||
    result.sessionId !== sessionId ||
    result.items.some((note) => note.sessionId !== sessionId)
  )
    throw new Error('Session journal response failed the shared runtime contract.');
  return result;
}

function terminalText(value: string): string {
  return [...stripVTControlCharacters(value)]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code >= 32 &&
        (code < 127 || code > 159) &&
        (code < 0x202a || code > 0x202e) &&
        (code < 0x2066 || code > 0x2069)
      );
    })
    .join('');
}

export function formatRecallCitation(source: RecallCitation): string {
  if (source.kind === 'session_note')
    return `[${source.id}] User-authored ${source.noteKind} by ${terminalText(source.authorName)} at ${terminalText(source.createdAt)} — not independently verified\n   ${terminalText(source.locator)}`;
  return `[${source.id}] ${terminalText(source.locator)}`;
}
