import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { LocalOutbox, type Binding } from './local.js';
import { resolveSyncFilter, synchronizeOutbox } from './outbox-sync.js';

const repositoryId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const otherSession = '33333333-3333-4333-8333-333333333333';
const binding: Binding = { schemaVersion: 1, repositoryId, apiUrl: 'http://127.0.0.1:4000' };
const access = { origin: binding.apiUrl, token: 'private-outbox-sync-fixture-token-32-characters' };

function add(outbox: LocalOutbox, session = sessionId): CapturedEvent {
  const eventId = randomUUID();
  const initial = {
    eventId,
    repositoryId,
    sessionId: session,
    startedAt: '2026-10-21T10:00:00.000Z',
    command: { executable: 'node', args: ['same-command.js'], shell: 'direct' },
    cwd: 'C:\\fixture',
    git: { commitSha: null, dirty: false },
    diffs: [],
  };
  const sequence = outbox.begin(eventId, session, initial);
  const event: CapturedEvent = {
    ...initial,
    sequence,
    endedAt: '2026-10-21T10:00:01.000Z',
    outcome: { kind: 'completed', exitCode: 0, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [],
  };
  outbox.finalize(eventId, event);
  return event;
}

function ack(ids: unknown): Response {
  return Response.json({ acknowledgedEventIds: ids, requestId: 'fixture' });
}

function sentEvents(init: RequestInit | undefined): CapturedEvent[] {
  return (JSON.parse(String(init?.body)) as { events: CapturedEvent[] }).events;
}

afterEach(() => vi.unstubAllGlobals());

describe('selected immutable outbox upload', () => {
  it('validates selectors before any local or network work', () => {
    expect(resolveSyncFilter()).toBeUndefined();
    expect(resolveSyncFilter(sessionId)).toEqual({ sessionId });
    expect(resolveSyncFilter(undefined, sessionId)).toEqual({ eventId: sessionId });
    for (const pair of [
      [sessionId, sessionId],
      ['', undefined],
      [null, undefined],
      [1, undefined],
    ])
      expect(() => resolveSyncFilter(...(pair as [unknown, unknown]))).toThrow('either --session');
  });

  it('does not widen malformed helper filters into an all-pending upload', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      add(outbox);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      for (const invalid of [null, [], 0, { unknown: sessionId }, Object.create({ sessionId })])
        await expect(synchronizeOutbox(outbox, binding, access, invalid as never)).rejects.toThrow(
          'selection',
        );
      expect(outbox.counts().pending).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      outbox.close();
    }
  });

  it('selects healthy rows before parsing an unrelated malformed pending row', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      const bad = randomUUID();
      outbox.begin(bad, otherSession, {});
      outbox.finalize(bad, { privateContent: 'unrelated malformed metadata' });
      const first = add(outbox);
      const second = add(outbox);
      const expected = outbox.pending({ sessionId }).map((row) => row.payload);
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
        ack(sentEvents(init).map((event) => event.eventId)),
      );
      vi.stubGlobal('fetch', fetch);
      const result = await synchronizeOutbox(outbox, binding, access, { sessionId });
      expect(result.acknowledgedEvents).toBe(2);
      expect(result.remaining).toEqual({ pending: 0, incomplete: 0 });
      expect(result.totalRemaining).toEqual({ pending: 1, incomplete: 0 });
      expect(sentEvents(fetch.mock.calls[0]?.[1])).toEqual(expected);
      expect(new Set(expected.map((row) => row['eventId']))).toEqual(
        new Set([first.eventId, second.eventId]),
      );
      expect(outbox.pending().map((row) => row.eventId)).toEqual([bad]);
      await expect(synchronizeOutbox(outbox, binding, access)).rejects.toThrow('invalid envelope');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      outbox.close();
    }
  });

  it('retains a lost response for an exact-identity retry and leaves new rows beyond the cutoff pending', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      const event = add(outbox);
      let newEvent: CapturedEvent | undefined;
      const durable = new Map<string, CapturedEvent>();
      let loseResponse = true;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const events = sentEvents(init);
        for (const row of events) durable.set(row.eventId, row);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('Fixture response lost after durable commit.');
        }
        newEvent = add(outbox);
        return ack(events.map((row) => row.eventId));
      });
      vi.stubGlobal('fetch', fetch);
      await expect(synchronizeOutbox(outbox, binding, access)).rejects.toThrow('response lost');
      expect(outbox.counts().pending).toBe(1);
      const result = await synchronizeOutbox(outbox, binding, access);
      expect(result.acknowledgedEvents).toBe(1);
      expect(result.remaining.pending).toBe(1);
      expect(durable.size).toBe(1);
      expect([...durable.values()]).toEqual([event]);
      expect(sentEvents(fetch.mock.calls[0]?.[1])).toEqual(sentEvents(fetch.mock.calls[1]?.[1]));
      expect(outbox.pending().map((row) => row.eventId)).toEqual([newEvent?.eventId]);
    } finally {
      outbox.close();
    }
  });

  it.each(['duplicate', 'foreign', 'empty', 'malformed'] as const)(
    'rejects %s acknowledgements before changing any local row',
    async (kind) => {
      const outbox = new LocalOutbox(':memory:');
      try {
        const event = add(outbox);
        const ids = {
          duplicate: [event.eventId, event.eventId],
          foreign: [event.eventId, randomUUID()],
          empty: [],
          malformed: [event.eventId, 'not-a-uuid'],
        }[kind];
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ack(ids)),
        );
        await expect(synchronizeOutbox(outbox, binding, access)).rejects.toThrow();
        expect(outbox.counts().pending).toBe(1);
      } finally {
        outbox.close();
      }
    },
  );

  it('acknowledges only a valid subset before retrying the remaining exact event', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      add(outbox);
      add(outbox);
      const events = outbox.pending().map((row) => row.eventId);
      const calls: string[][] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          const ids = sentEvents(init).map((event) => event.eventId);
          calls.push(ids);
          return ack(ids.slice(0, 1));
        }),
      );
      const result = await synchronizeOutbox(outbox, binding, access);
      expect(calls).toEqual([events, [events[1]!]]);
      expect(result.acknowledgedEvents).toBe(2);
      expect(result.remaining.pending).toBe(0);
    } finally {
      outbox.close();
    }
  });

  it('counts concurrent local acknowledgements once', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      const event = add(outbox);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ack([event.eventId])),
      );
      const results = await Promise.all([
        synchronizeOutbox(outbox, binding, access),
        synchronizeOutbox(outbox, binding, access),
      ]);
      expect(results.reduce((sum, result) => sum + result.acknowledgedEvents, 0)).toBe(1);
      expect(outbox.counts().pending).toBe(0);
    } finally {
      outbox.close();
    }
  });

  it('rejects otherwise valid payloads that disagree with the stored identity or bound repository', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      add(outbox);
      const row = outbox.pending()[0]!;
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      for (const mismatch of [
        { eventId: randomUUID() },
        { sessionId: otherSession },
        { sequence: row.sequence + 1 },
        { repositoryId: randomUUID() },
      ]) {
        const acknowledge = vi.fn(() => 0);
        await expect(
          synchronizeOutbox(
            {
              lastRowId: () => outbox.lastRowId(),
              pending: () => [{ ...row, payload: { ...row.payload, ...mismatch } }],
              counts: () => outbox.counts(),
              acknowledge,
            },
            binding,
            access,
          ),
        ).rejects.toThrow('inconsistent repository/session identity');
        expect(acknowledge).not.toHaveBeenCalled();
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(outbox.counts().pending).toBe(1);
    } finally {
      outbox.close();
    }
  });

  it('discloses the batch cap instead of claiming the outbox is drained', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      add(outbox);
      const row = outbox.pending()[0]!;
      const limited = {
        lastRowId: () => 1,
        pending: () => [row],
        counts: () => ({ pending: 1, incomplete: 0 }),
        acknowledge: () => 1,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ack([row.eventId])),
      );
      const result = await synchronizeOutbox(limited, binding, access);
      expect(result.stopReason).toBe('batch_limit');
      expect(result.remaining.pending).toBe(1);
      expect(result.acknowledgedEvents).toBe(100);
    } finally {
      outbox.close();
    }
  });
});
