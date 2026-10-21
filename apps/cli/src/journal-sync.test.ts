import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalContext, SessionEventsPage, SessionNote } from '@memvora/contracts';
import { JournalOutbox, readJournalOutboxPage } from './journal-outbox.js';
import { queueBoundJournalNote, retryJournalNote } from './journal-sync.js';
import type { Binding } from './local.js';

const origin = 'http://127.0.0.1:4000';
const repositoryId = '13100000-0000-4000-8000-000000000001';
const sessionId = '13100000-0000-4000-8000-000000000002';
const eventId = '13100000-0000-4000-8000-000000000003';
const context: LocalContext = {
  mode: 'local',
  user: { id: '13100000-0000-4000-8000-000000000004', name: 'Synthetic journal author' },
  workspace: {
    id: '13100000-0000-4000-8000-000000000005',
    name: 'Synthetic journal workspace',
    generation: 1,
  },
};
const binding: Binding = { schemaVersion: 1, repositoryId, sessionId, apiUrl: origin };
const temporaryRoot = realpathSync(tmpdir());
const directories: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(temporaryRoot, 'memvora-journal-sync-'));
  directories.push(root);
  return root;
};
const page: SessionEventsPage = {
  session: {
    id: sessionId,
    repositoryId,
    title: 'Synthetic journal retry parent',
    status: 'open',
    createdAt: '2026-10-21T08:00:00.000Z',
    closedAt: null,
    eventCount: 0,
    memoryCount: 0,
  },
  events: [],
  memories: [],
  page: {
    snapshotEventCount: 0,
    returnedEvents: 0,
    firstSequence: null,
    lastSequence: null,
    olderCursor: null,
    newerCursor: null,
  },
};
const input = () => ({
  id: randomUUID(),
  kind: 'decision' as const,
  body: 'Synthetic authored claim, not a verified fix.',
  eventIds: [eventId],
});
function accepted(value: ReturnType<typeof input>): SessionNote {
  return {
    id: value.id,
    kind: value.kind,
    body: value.body,
    sessionId,
    repositoryId,
    author: context.user,
    createdAt: '2026-10-21T08:10:00.000Z',
    label: 'User-authored — not independently verified',
    sources: value.eventIds.map((id) => ({
      id,
      repositoryId,
      kind: 'event',
      locator: `/v1/events/${id}`,
    })),
  };
}
function stored(root: string, id: string) {
  const outbox = new JournalOutbox(root, { create: false });
  try {
    return outbox.get(id)!;
  } finally {
    outbox.close();
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of directories.splice(0)) {
    const resolved = realpathSync(root);
    if (
      resolved !== root ||
      dirname(resolved) !== temporaryRoot ||
      !basename(resolved).startsWith('memvora-journal-sync-') ||
      lstatSync(resolved).isSymbolicLink()
    )
      throw new Error('Unsafe journal sync test cleanup');
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('explicit durable journal retry', () => {
  it('queues normalized redacted evidence offline and rejects changed bound scope before creation', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const root = fixture();
    const value = {
      ...input(),
      body: '\u001b[31mSynthetic token fixture\r\nAuthorization: Bearer queue-secret-at-least-thirty-two-chars\u001b[0m',
    };
    const queued = queueBoundJournalNote(root, binding, sessionId, origin, value);
    expect(queued).toMatchObject({
      mode: 'queued_locally',
      serverContacted: false,
      item: { state: 'pending', noteId: value.id },
    });
    expect(stored(root, value.id).input.body).not.toContain('queue-secret');
    expect(JSON.stringify(readJournalOutboxPage({ root }))).not.toContain(
      'Synthetic token fixture',
    );
    expect(fetcher).not.toHaveBeenCalled();
    const other = fixture();
    expect(() => queueBoundJournalNote(other, binding, randomUUID(), origin, value)).toThrow(
      'current bound',
    );
    expect(() =>
      queueBoundJournalNote(other, binding, sessionId, 'http://127.0.0.1:4999', value),
    ).toThrow('differs');
    expect(existsSync(join(other, '.memvora'))).toBe(false);
  });

  it('reopens after response loss, preserves identity and acknowledges only the exact replay, without refetching acknowledged work', async () => {
    const root = fixture(),
      value = input();
    queueBoundJournalNote(root, binding, sessionId, origin, value);
    let postCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/v1/me')) return Response.json(context);
      if (String(url).endsWith('/events?limit=1')) return Response.json(page);
      postCalls++;
      expect(JSON.parse(String(init?.body))).toEqual(value);
      if (postCalls === 1) throw new Error('Synthetic response lost after acceptance');
      return Response.json({ note: accepted(value) });
    });
    vi.stubGlobal('fetch', fetcher);
    const selected = { root, binding, origin, noteId: value.id };
    await expect(retryJournalNote(selected, () => 'Synthetic journal token')).rejects.toThrow(
      'note was retained',
    );
    expect(stored(root, value.id)).toMatchObject({
      peer: { userId: context.user.id, workspaceGeneration: 1 },
      metadata: { state: 'pending' },
    });
    const nextBinding = { ...binding, sessionId: randomUUID() };
    await expect(
      retryJournalNote({ ...selected, binding: nextBinding }, () => 'Synthetic journal token'),
    ).resolves.toMatchObject({
      mode: 'confirmed',
      submissionPerformed: true,
      item: { state: 'synced' },
    });
    const calls = fetcher.mock.calls.length;
    await expect(
      retryJournalNote(selected, () => {
        throw new Error('Must not read a credential');
      }),
    ).resolves.toMatchObject({ mode: 'already_acknowledged', submissionPerformed: false });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(postCalls).toBe(2);
  });

  it('retains schema-valid mismatched acknowledgements and hides private error text', async () => {
    const root = fixture();
    const changes: Array<(note: SessionNote) => SessionNote> = [
      (note) => ({ ...note, body: 'Wrong report body' }),
      (note) => ({ ...note, kind: 'resolution' }),
      (note) => ({ ...note, repositoryId: randomUUID() }),
      (note) => ({ ...note, author: { ...note.author, id: randomUUID() } }),
      (note) => ({ ...note, sources: [] }),
      (note) => ({ ...note, sources: [{ ...note.sources[0]!, id: randomUUID() }] }),
      (note) => ({
        ...note,
        sources: [{ ...note.sources[0]!, locator: 'https://example.invalid/private' }],
      }),
    ];
    for (const change of changes) {
      const value = input();
      queueBoundJournalNote(root, binding, sessionId, origin, value);
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url) =>
          String(url).endsWith('/v1/me')
            ? Response.json(context)
            : String(url).endsWith('/events?limit=1')
              ? Response.json(page)
              : Response.json({ note: change(accepted(value)) }),
        ),
      );
      const error = await retryJournalNote(
        { root, binding, origin, noteId: value.id },
        () => 'Synthetic private token',
      ).catch((e) => e);
      expect(String(error)).toContain(value.id);
      expect(String(error)).not.toContain(value.body);
      expect(stored(root, value.id).metadata.state).toBe('pending');
    }
  });

  it('blocks changed peer, parent repository and local binding before transmitting the saved note', async () => {
    const root = fixture(),
      value = input();
    queueBoundJournalNote(root, binding, sessionId, origin, value);
    const selected = { root, binding, origin, noteId: value.id };
    const outbox = new JournalOutbox(root, { create: false });
    outbox.pinPrincipal(value.id, stored(root, value.id).digest, {
      userId: context.user.id,
      workspaceId: context.workspace.id,
      workspaceGeneration: 1,
    });
    outbox.close();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ...context, workspace: { ...context.workspace, generation: 2 } }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(retryJournalNote(selected, () => 'Synthetic token')).rejects.toThrow(
      'note was retained',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(
      retryJournalNote(
        { ...selected, binding: { ...binding, repositoryId: randomUUID() } },
        () => 'Synthetic token',
      ),
    ).rejects.toThrow('Nothing was sent');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementation(async (url) =>
      String(url).endsWith('/v1/me')
        ? Response.json(context)
        : Response.json({ ...page, session: { ...page.session, repositoryId: randomUUID() } }),
    );
    await expect(retryJournalNote(selected, () => 'Synthetic token')).rejects.toThrow(
      'note was retained',
    );
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(stored(root, value.id).metadata.state).toBe('pending');
  });
});
