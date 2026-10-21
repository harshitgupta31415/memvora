import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { Check } from 'typebox/value';
import { SessionHandoverSchema } from '@memvora/contracts';
import type { CapturedEvent, HandoverEvent, SessionHandover } from '@memvora/contracts';
import { DomainError, redactText } from './local-service.js';
import type { SessionHandoverEvidence } from './local-service.js';
import { deriveSessionRecap } from './session-recap.js';

function invalid(): never {
  throw new DomainError('INVALID_HANDOVER_EVIDENCE', 'The handover evidence is inconsistent.', 500);
}

/** Normalize first: removing controls can join previously separated credential fragments. */
function clean(value: string): string {
  let printable = '';
  for (const character of stripVTControlCharacters(value).replace(/\r\n?/gu, '\n')) {
    const point = character.codePointAt(0)!;
    if (
      ((point >= 32 && (point < 127 || point > 159)) || character === '\n' || character === '\t') &&
      !(point >= 0x202a && point <= 0x202e) &&
      !(point >= 0x2066 && point <= 0x2069)
    )
      printable += character;
  }
  return redactText(printable);
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit < 1) return '';
  let result = value.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/u.test(result)) result = result.slice(0, -1);
  return `${result}…`;
}

function timestamp(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) invalid();
  return time.toISOString();
}

function outputText(event: CapturedEvent): string {
  let value = '';
  let stream: 'stdout' | 'stderr' | undefined;
  for (const chunk of [...event.output].sort((a, b) => a.ordinal - b.ordinal)) {
    if (chunk.stream !== stream) {
      if (value && !value.endsWith('\n')) value += '\n';
      value += `[${chunk.stream}] `;
      stream = chunk.stream;
    }
    value += chunk.text;
  }
  return clean(value);
}

/** One consistent adapter snapshot; no writes, provider calls, or claims about engineer intent. */
export function deriveSessionHandover(evidence: SessionHandoverEvidence): SessionHandover {
  const { repository, recapEvidence, notes, totalNoteCount, events, totalEventCount } = evidence;
  const { session } = recapEvidence;
  const eventIds = new Set(events.map((event) => event.eventId));
  const selectedIds = new Set(recapEvidence.events.map((event) => event.eventId));
  if (
    repository.id !== session.repositoryId ||
    !Number.isSafeInteger(totalEventCount) ||
    totalEventCount !== recapEvidence.totalEventCount ||
    totalEventCount !== session.eventCount ||
    totalEventCount < events.length ||
    events.length > 140 ||
    eventIds.size !== events.length ||
    !Number.isSafeInteger(totalNoteCount) ||
    totalNoteCount < notes.length ||
    notes.length !== Math.min(10, totalNoteCount) ||
    new Set(notes.map((note) => note.id)).size !== notes.length ||
    events.some(
      (event, index) =>
        event.sessionId !== session.id ||
        event.repositoryId !== repository.id ||
        (index > 0 && event.sequence <= events[index - 1]!.sequence),
    ) ||
    recapEvidence.events.some((event) => !eventIds.has(event.eventId)) ||
    notes.some(
      (note) =>
        note.sessionId !== session.id ||
        note.repositoryId !== repository.id ||
        note.sources.some(
          (source) =>
            source.kind !== 'event' ||
            source.repositoryId !== repository.id ||
            !eventIds.has(source.id),
        ),
    )
  )
    invalid();

  for (const note of notes) for (const source of note.sources) selectedIds.add(source.id);
  if (selectedIds.size !== eventIds.size || [...eventIds].some((id) => !selectedIds.has(id)))
    invalid();
  const byId = new Map(events.map((event) => [event.eventId, event]));
  // A repeated ID with different evidence must never create two contradictory offline accounts.
  if (recapEvidence.events.some((event) => !isDeepStrictEqual(event, byId.get(event.eventId))))
    invalid();

  const safeSession = {
    ...session,
    title: clip(clean(session.title), 200),
    createdAt: timestamp(session.createdAt),
    closedAt: session.closedAt === null ? null : timestamp(session.closedAt),
  };
  const prepared = events.map((event) => {
    const command = clean([event.command.executable, ...event.command.args].join(' '));
    const cwd = clean(event.cwd);
    const output = outputText(event);
    const diffs = event.diffs.map((diff) => ({ ...diff, text: clean(diff.text) }));
    const safe: HandoverEvent = {
      eventId: event.eventId,
      repositoryId: event.repositoryId,
      sessionId: event.sessionId,
      sequence: event.sequence,
      startedAt: timestamp(event.startedAt),
      endedAt: timestamp(event.endedAt),
      commandExcerpt: clip(command, 512),
      commandTruncated: command.length > 512,
      cwdExcerpt: clip(cwd, 512),
      cwdTruncated: cwd.length > 512,
      git: {
        commitSha: event.git.commitSha,
        dirty: event.git.dirty,
        error: event.git.error === undefined ? null : clip(clean(event.git.error), 200),
      },
      outcome: {
        kind: event.outcome.kind,
        exitCode: event.outcome.exitCode,
        signal: event.outcome.signal === null ? null : clip(clean(event.outcome.signal), 100),
        error: event.outcome.error
          ? {
              code: clip(clean(event.outcome.error.code), 100),
              message: clip(clean(event.outcome.error.message), 300),
            }
          : null,
      },
      capture: { ...event.capture },
      outputExcerpt: '',
      outputTruncated: false,
      diffs: [],
    };
    return { safe, command, output, diffs };
  });
  const preparedById = new Map(prepared.map((value) => [value.safe.eventId, value]));
  const recap = deriveSessionRecap({
    ...recapEvidence,
    session: safeSession,
    events: recapEvidence.events.map((event) => {
      const value = preparedById.get(event.eventId)!;
      return {
        ...event,
        command: { ...event.command, executable: value.command || '(empty display)', args: [] },
        outcome: { ...event.outcome, signal: value.safe.outcome.signal },
        output: value.output ? [{ stream: 'stdout' as const, ordinal: 0, text: value.output }] : [],
        diffs: value.diffs,
      };
    }),
  });
  // output already carries original stream labels; avoid adding a synthetic stdout label twice.
  recap.steps.forEach((step) => {
    step.outputExcerpt = clip(preparedById.get(step.eventId)!.output, 600);
  });
  const generatedAt = new Date().toISOString();
  recap.generatedAt = generatedAt;
  const report: SessionHandover = {
    schemaVersion: 1,
    kind: 'memvora_investigation_handover',
    generatedAt,
    repository: {
      id: repository.id,
      name: clip(clean(repository.name), 120),
      remoteUrl: repository.remoteUrl === null ? null : clip(clean(repository.remoteUrl), 2048),
    },
    session: safeSession,
    recap,
    notes: notes.map((note) => ({
      ...note,
      body: clip(clean(note.body), 4000),
      author: { ...note.author, name: clip(clean(note.author.name), 100) },
      createdAt: timestamp(note.createdAt),
      sources: note.sources.map((source) => ({ ...source, locator: `/v1/events/${source.id}` })),
    })),
    coverage: {
      totalEvents: totalEventCount,
      includedEvents: events.length,
      omittedEvents: totalEventCount - events.length,
      recapEvents: recapEvidence.events.length,
      eventLimit: 140,
      totalNotes: totalNoteCount,
      includedNotes: notes.length,
      omittedNotes: totalNoteCount - notes.length,
      noteLimit: 10,
      selection: totalEventCount > 40 ? 'first_and_last_plus_note_sources' : 'all',
      repositoryFilesIncluded: false,
      derivedMemoriesIncluded: false,
    },
    events: [],
    excerptLimit: 6000,
    serializedByteLimit: 2097152,
    notices: [
      'Personal, portable investigation excerpts. This is not a full database backup, complete repository export, or company access-control mechanism.',
      'The recap covers all attempts up to 40, otherwise the first 20 and last 20. Its counts describe that selection only. Exported events also include every source linked by the latest ten authored notes.',
      'Older notes and remaining middle attempts may be omitted. Repository-file contents and derived memory records are not included. Consult coverage before treating this as complete history.',
      'Authored notes, decisions and reported resolutions are claims by their named author, not independently verified facts. Command success does not establish a root cause or causal fix.',
      'Commands, paths, output and diffs are display excerpts. Export clipping is separate from original capture truncation. Diff snapshots can include pre-existing changes; displayed command text is not an executable script.',
      'Event IDs and note IDs resolve to records in this file. API locators refer to the originating local instance and may become unavailable. This report includes no repository-file citations.',
      'This file can contain private code or terminal information. Known-pattern redaction is not guaranteed to detect every secret. Review it before sharing. No external upload is performed.',
      'A saved copy does not follow later deletion, disconnection or access changes in the originating database. Its recipient controls that independent copy.',
    ],
  };
  for (const limit of [6000, 3000, 1500, 750, 256, 64, 0]) {
    report.excerptLimit = limit;
    report.events = prepared.map(({ safe, output, diffs }) => ({
      ...safe,
      outputExcerpt: clip(output, limit),
      outputTruncated: output.length > limit,
      diffs: diffs.map((diff) => ({
        phase: diff.phase,
        text: clip(diff.text, limit),
        excerptTruncated: diff.text.length > limit,
        capturedTruncatedBytes: diff.truncatedBytes,
      })),
    }));
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= report.serializedByteLimit) {
      if (!Check(SessionHandoverSchema, report)) invalid();
      return report;
    }
  }
  throw new DomainError(
    'HANDOVER_TOO_LARGE',
    'The handover exceeds the portable report size limit.',
    413,
  );
}
