import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { uuidPattern } from '@memvora/contracts';
import type { CreateSessionNote, SessionNote, SessionNoteCitation } from '@memvora/contracts';
import { DomainError, redactText } from './local-service.js';

const uuid = new RegExp(uuidPattern);
const invalid = () =>
  new DomainError(
    'INVALID_SESSION_NOTE',
    'Use a valid note UUID, kind, nonblank body of up to 4,000 characters and up to ten unique event UUIDs.',
    400,
  );

/** Normalize the display representation before redaction, then hash only what can be persisted. */
export function prepareSessionNote(input: CreateSessionNote): {
  input: CreateSessionNote;
  digest: string;
} {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).sort().join(',') !== 'body,eventIds,id,kind' ||
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    !['note', 'decision', 'resolution'].includes(input.kind) ||
    typeof input.body !== 'string' ||
    input.body.length < 1 ||
    input.body.length > 4000 ||
    !Array.isArray(input.eventIds) ||
    input.eventIds.length > 10 ||
    input.eventIds.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
    new Set(input.eventIds).size !== input.eventIds.length
  )
    throw invalid();
  let printable = '';
  for (const character of stripVTControlCharacters(input.body).replace(/\r\n?/gu, '\n')) {
    const point = character.codePointAt(0)!;
    if (
      ((point >= 32 && (point < 127 || point > 159)) || character === '\n' || character === '\t') &&
      !(point >= 0x202a && point <= 0x202e) &&
      !(point >= 0x2066 && point <= 0x2069)
    )
      printable += character;
  }
  const body = redactText(printable).trim();
  if (!body || body.length > 4000) throw invalid();
  const normalized: CreateSessionNote = {
    id: input.id,
    kind: input.kind,
    body,
    eventIds: [...input.eventIds].sort(),
  };
  return {
    input: normalized,
    digest: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}

export function sessionNoteCitation(note: SessionNote): SessionNoteCitation {
  return {
    id: note.id,
    kind: 'session_note',
    repositoryId: note.repositoryId,
    sessionId: note.sessionId,
    locator: `/v1/session-notes/${note.id}`,
    authorName: note.author.name,
    createdAt: note.createdAt,
    noteKind: note.kind,
  };
}
