import { Check } from 'typebox/value';
import { EventSchema, IdSchema, type EventAck } from '@memvora/contracts';
import { apiRequest, type Binding, type LocalOutbox, type OutboxFilter } from './local.js';

/** Resolve selectors before opening a binding, credential or writable outbox. */
export function resolveSyncFilter(
  sessionId?: unknown,
  eventId?: unknown,
): OutboxFilter | undefined {
  if (
    (sessionId !== undefined && !Check(IdSchema, sessionId)) ||
    (eventId !== undefined && !Check(IdSchema, eventId)) ||
    (sessionId !== undefined && eventId !== undefined)
  )
    throw new Error('Use either --session <UUID> or --event <UUID> to select pending evidence.');
  if (sessionId !== undefined) return { sessionId: sessionId as string };
  if (eventId !== undefined) return { eventId: eventId as string };
  return undefined;
}

type SyncOutbox = Pick<LocalOutbox, 'pending' | 'acknowledge' | 'counts' | 'lastRowId'>;

export interface OutboxSyncResult {
  scope: OutboxFilter;
  acknowledgedEvents: number;
  remaining: { pending: number; incomplete: number };
  totalRemaining: { pending: number; incomplete: number };
  startedAtRowId: number;
  stopReason: 'no_eligible_pending' | 'batch_limit';
}

/** No database transaction is kept open across an HTTP request. */
export async function synchronizeOutbox(
  outbox: SyncOutbox,
  binding: Binding,
  connection: { origin: string; token: string },
  filter?: OutboxFilter,
): Promise<OutboxSyncResult> {
  // Revalidate the filter at this independently callable boundary.
  if (
    filter !== undefined &&
    (!filter ||
      typeof filter !== 'object' ||
      Array.isArray(filter) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(filter)) ||
      Object.keys(filter).some((key) => !['sessionId', 'eventId'].includes(key)))
  )
    throw new Error('Invalid local evidence selection.');
  const scope = resolveSyncFilter(filter?.sessionId, filter?.eventId);
  const startedAtRowId = outbox.lastRowId();
  let acknowledgedEvents = 0;
  const result = (stopReason: OutboxSyncResult['stopReason']): OutboxSyncResult => ({
    scope: scope ?? {},
    acknowledgedEvents,
    remaining: outbox.counts(scope),
    totalRemaining: outbox.counts(),
    startedAtRowId,
    stopReason,
  });
  for (let batch = 0; batch < 100; batch++) {
    const selected = outbox.pending(scope, startedAtRowId);
    if (!selected.length) return result('no_eligible_pending');
    if (
      selected.some(
        (row) =>
          !Check(EventSchema, row.payload) ||
          row.payload['eventId'] !== row.eventId ||
          row.payload['sessionId'] !== row.sessionId ||
          row.payload['sequence'] !== row.sequence ||
          row.payload['repositoryId'] !== binding.repositoryId ||
          (scope?.sessionId !== undefined && row.payload['sessionId'] !== scope.sessionId) ||
          (scope?.eventId !== undefined && row.eventId !== scope.eventId),
      )
    )
      throw new Error(
        'Pending local evidence has an invalid envelope or inconsistent repository/session identity. Evidence was retained; inspect the outbox and select another session or event if needed.',
      );
    const response = await apiRequest<EventAck>(
      connection.origin,
      connection.token,
      '/v1/events/batch',
      { schemaVersion: 1, events: selected.map((row) => row.payload) },
    );
    const ids = response.acknowledgedEventIds;
    const uploaded = selected.map((row) => row.eventId);
    const allowed = new Set(uploaded);
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length !== new Set(ids).size ||
      ids.some((id) => !Check(IdSchema, id) || !allowed.has(id))
    )
      throw new Error('Invalid exact-acknowledgement response. Pending evidence retained.');
    acknowledgedEvents += outbox.acknowledge(ids, uploaded);
  }
  return result('batch_limit');
}
