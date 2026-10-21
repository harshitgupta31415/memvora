import { Check } from 'typebox/value';
import {
  IdSchema,
  MeSchema,
  SessionEventsPageSchema,
  type CreateSessionNote,
  type LocalContext,
  type SessionEventsPage,
  type SessionNote,
} from '@memvora/contracts';
import { apiRequest, type Binding } from './local.js';
import {
  canonicalJournalOrigin,
  JournalOutbox,
  type JournalOutboxItem,
  type JournalPeer,
  type QueuedJournalNote,
} from './journal-outbox.js';
import { submitSessionNote } from './session-notes.js';

function selectedOrigin(binding: Binding, origin: string): string {
  if (!Check(IdSchema, binding.repositoryId))
    throw new Error('A valid capture repository binding is required.');
  const selected = canonicalJournalOrigin(origin);
  if (selected !== canonicalJournalOrigin(binding.apiUrl))
    throw new Error('The selected API differs from the capture binding. No journal work was sent.');
  return selected;
}

export function queueBoundJournalNote(
  root: string,
  binding: Binding,
  sessionId: string,
  origin: string,
  input: CreateSessionNote,
): {
  mode: 'queued_locally' | 'already_acknowledged';
  serverContacted: false;
  item: JournalOutboxItem;
} {
  const apiOrigin = selectedOrigin(binding, origin);
  if (!Check(IdSchema, sessionId) || sessionId !== binding.sessionId)
    throw new Error(
      'Queue notes only for the current bound investigation. No journal work was sent.',
    );
  const outbox = new JournalOutbox(root, { create: true });
  try {
    const item = outbox.enqueue(
      { apiOrigin, repositoryId: binding.repositoryId, sessionId },
      input,
    );
    return {
      mode: item.state === 'synced' ? 'already_acknowledged' : 'queued_locally',
      serverContacted: false,
      item,
    };
  } finally {
    outbox.close();
  }
}

function matchesAcknowledgement(note: SessionNote, record: QueuedJournalNote, peer: JournalPeer) {
  return (
    note.id === record.input.id &&
    note.repositoryId === record.scope.repositoryId &&
    note.sessionId === record.scope.sessionId &&
    note.kind === record.input.kind &&
    note.body === record.input.body &&
    note.author.id === peer.userId &&
    note.sources.length === record.input.eventIds.length &&
    new Set(note.sources.map((source) => source.id)).size === note.sources.length &&
    note.sources.every(
      (source) =>
        source.kind === 'event' &&
        source.repositoryId === record.scope.repositoryId &&
        source.locator === `/v1/events/${source.id}` &&
        record.input.eventIds.includes(source.id),
    )
  );
}

export type JournalRetryResult = {
  mode: 'confirmed' | 'already_acknowledged';
  submissionPerformed: boolean;
  item: JournalOutboxItem;
};

/** Explicitly retries one immutable note. No transaction is held across network work. */
export async function retryJournalNote(
  selected: { root: string; binding: Binding; origin: string; noteId: string },
  getToken: () => string,
): Promise<JournalRetryResult> {
  if (!Check(IdSchema, selected.noteId)) throw new Error('Choose one valid note UUID with --note.');
  const apiOrigin = selectedOrigin(selected.binding, selected.origin);
  const outbox = new JournalOutbox(selected.root, { create: false });
  try {
    const record = outbox.get(selected.noteId);
    if (!record) throw new Error('The selected note is not in this local journal outbox.');
    if (
      record.scope.repositoryId !== selected.binding.repositoryId ||
      record.scope.apiOrigin !== apiOrigin
    )
      throw new Error('The saved note does not match this repository and API. Nothing was sent.');
    if (record.metadata.state === 'synced')
      return { mode: 'already_acknowledged', submissionPerformed: false, item: record.metadata };
    try {
      const token = getToken();
      const context = await apiRequest<LocalContext>(apiOrigin, token, '/v1/me');
      if (!Check(MeSchema, context)) throw new Error('Invalid authenticated peer.');
      const peer: JournalPeer = {
        userId: context.user.id,
        workspaceId: context.workspace.id,
        workspaceGeneration: context.workspace.generation,
      };
      if (
        record.peer &&
        (record.peer.userId !== peer.userId ||
          record.peer.workspaceId !== peer.workspaceId ||
          record.peer.workspaceGeneration !== peer.workspaceGeneration)
      )
        throw new Error('The authenticated peer changed.');
      const parent = await apiRequest<SessionEventsPage>(
        apiOrigin,
        token,
        `/v1/sessions/${record.scope.sessionId}/events?limit=1`,
      );
      if (
        !Check(SessionEventsPageSchema, parent) ||
        parent.session.id !== record.scope.sessionId ||
        parent.session.repositoryId !== record.scope.repositoryId
      )
        throw new Error('The parent investigation could not be verified.');
      outbox.pinPrincipal(selected.noteId, record.digest, peer);
      const response = await submitSessionNote(
        apiOrigin,
        token,
        record.scope.sessionId,
        record.input,
      );
      if (!matchesAcknowledgement(response.note, record, peer))
        throw new Error('The acknowledgement did not match the saved note.');
      return {
        mode: 'confirmed',
        submissionPerformed: true,
        item: outbox.acknowledge(selected.noteId, record.digest),
      };
    } catch {
      throw new Error(
        `Journal submission was not confirmed by this attempt. The original local note was retained. Inspect journal list, then explicitly retry with journal retry --note ${selected.noteId} if still pending. No automatic retry was performed.`,
      );
    }
  } finally {
    outbox.close();
  }
}
