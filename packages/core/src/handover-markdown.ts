import { stripVTControlCharacters } from 'node:util';
import { uuidPattern, type SessionHandover } from '@memvora/contracts';
import { DomainError } from './local-service.js';

const uuid = new RegExp(uuidPattern);
const maximumMarkdownBytes = 8 * 1024 * 1024;

function anchor(kind: 'event' | 'note', id: string): string {
  if (!uuid.test(id)) throw new Error('Handover contains an invalid citation identity.');
  return `${kind}-${id}`;
}

function printable(value: string): string {
  let text = '';
  for (const character of stripVTControlCharacters(value).replace(/\r\n?/gu, '\n')) {
    const point = character.codePointAt(0)!;
    if (
      ((point >= 32 && (point < 127 || point > 159)) || character === '\n' || character === '\t') &&
      !(point >= 0x202a && point <= 0x202e) &&
      !(point >= 0x2066 && point <= 0x2069)
    )
      text += character;
  }
  return text;
}

/** Evidence never becomes Markdown markup, an image, a URL target or raw HTML. */
function fenced(value: string): string {
  const text = printable(value);
  let longest = 0;
  for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function metadata(value: unknown): string {
  return fenced(JSON.stringify(value, null, 2));
}

/** A self-contained, inert rendering of an already scoped and redacted portable report. */
export function formatSessionHandoverMarkdown(report: SessionHandover): string {
  const events = new Map(report.events.map((event) => [event.eventId, event]));
  const noteIds = new Set(report.notes.map((note) => note.id));
  if (
    events.size !== report.events.length ||
    noteIds.size !== report.notes.length ||
    report.events.some(
      (event) =>
        event.sessionId !== report.session.id || event.repositoryId !== report.repository.id,
    ) ||
    report.notes.some(
      (note) => note.sessionId !== report.session.id || note.repositoryId !== report.repository.id,
    ) ||
    report.recap.session.id !== report.session.id ||
    report.session.repositoryId !== report.repository.id
  )
    throw new Error('Handover has inconsistent source scope.');
  for (const event of report.events) anchor('event', event.eventId);
  for (const note of report.notes) {
    anchor('note', note.id);
    if (events.has(note.id)) throw new Error('Handover citation identities are ambiguous.');
  }
  const citations = [...report.recap.sources, ...report.notes.flatMap((note) => note.sources)];
  if (
    citations.some(
      (source) =>
        source.kind !== 'event' ||
        !events.has(source.id) ||
        source.repositoryId !== report.repository.id,
    ) ||
    report.recap.steps.some((step) => !events.has(step.eventId))
  )
    throw new Error('Handover contains an unresolved offline event citation.');

  const lines: string[] = [
    '# Investigation handover',
    '',
    'Portable excerpts from one authorized local investigation. This is not a database backup or a complete command capture. Recorded outcomes are observations; authored notes are claims, not independent verification.',
    '',
    '## Scope and generation',
    '',
    metadata({
      schemaVersion: report.schemaVersion,
      kind: report.kind,
      generatedAt: report.generatedAt,
      repository: report.repository,
      session: report.session,
    }),
    '',
    '## Export coverage',
    '',
    'The exported event set includes the recap selection and every event cited by the included latest notes. Exported-event counts and recap outcome counts describe different selections. Omitted evidence can change interpretation.',
    '',
    metadata({
      ...report.coverage,
      excerptLimit: report.excerptLimit,
      serializedByteLimit: report.serializedByteLimit,
    }),
    '',
    '## Observed recap',
    '',
    fenced(report.recap.label),
    '',
    fenced(report.recap.summary),
    '',
    'The following counts cover only the recap selection of up to 40 attempts, including first/last selection where disclosed. They do not count every event added for a note citation.',
    '',
    metadata({
      generatedAt: report.recap.generatedAt,
      mode: report.recap.mode,
      coverage: report.recap.coverage,
      counts: report.recap.counts,
    }),
    '',
    '### Recap attempts',
    '',
  ];
  if (!report.recap.steps.length)
    lines.push('No accepted command evidence was included in the recap.', '');
  for (const step of report.recap.steps) {
    lines.push(
      `[Original event ${step.eventId}](#${anchor('event', step.eventId)})`,
      '',
      metadata({
        sequence: step.sequence,
        command: step.command,
        outcome: step.outcome,
        outputExcerpt: step.outputExcerpt,
        diffSummary: step.diffSummary,
      }),
      '',
    );
  }
  lines.push('### Recap uncertainty', '');
  for (const notice of report.recap.uncertainty) lines.push(fenced(notice), '');
  lines.push(
    '### Recap source locators',
    '',
    'These original API locators require the source local application. Offline evidence links above resolve within this file.',
    '',
    metadata(report.recap.sources),
    '',
  );

  lines.push('## User-authored journal', '');
  if (!report.notes.length) lines.push('No authored journal entries were included.', '');
  for (const note of report.notes) {
    lines.push(
      `<a id="${anchor('note', note.id)}"></a>`,
      '',
      `### Journal note ${note.id}`,
      '',
      metadata({
        id: note.id,
        repositoryId: note.repositoryId,
        sessionId: note.sessionId,
        kind: note.kind,
        author: note.author,
        createdAt: note.createdAt,
        label: note.label,
      }),
      '',
      fenced(note.body),
      '',
    );
    if (!note.sources.length) lines.push('This author supplied no linked command evidence.', '');
    for (const source of note.sources)
      lines.push(`[Linked event ${source.id}](#${anchor('event', source.id)})`, '');
    lines.push(
      'Original local API locator and attached source metadata:',
      '',
      metadata({ locator: `/v1/session-notes/${note.id}`, sources: note.sources }),
      '',
    );
  }

  lines.push('## Original event excerpts', '');
  if (!report.events.length) lines.push('No original events were included.', '');
  for (const event of report.events) {
    lines.push(
      `<a id="${anchor('event', event.eventId)}"></a>`,
      '',
      `### Recorded event ${event.eventId}`,
      '',
      metadata({
        eventId: event.eventId,
        repositoryId: event.repositoryId,
        sessionId: event.sessionId,
        sequence: event.sequence,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        git: event.git,
        outcome: event.outcome,
        capture: event.capture,
        commandTruncated: event.commandTruncated,
        cwdTruncated: event.cwdTruncated,
        outputTruncated: event.outputTruncated,
      }),
      '',
      '#### Command excerpt',
      '',
      fenced(event.commandExcerpt),
      '',
      '#### Working directory excerpt',
      '',
      fenced(event.cwdExcerpt),
      '',
      '#### Output excerpt',
      '',
      fenced(event.outputExcerpt),
      '',
    );
    if (!event.diffs.length) lines.push('No diff snapshots were included for this event.', '');
    for (const diff of event.diffs)
      lines.push(
        diff.phase === 'before'
          ? '#### Before-command diff snapshot'
          : '#### After-command diff snapshot',
        '',
        metadata({
          phase: diff.phase,
          baselineCommitSha: diff.baselineCommitSha ?? null,
          baselineStatus: diff.baselineCommitSha
            ? 'Explicit captured baseline'
            : 'Baseline not recorded',
          excerptTruncated: diff.excerptTruncated,
          capturedTruncatedBytes: diff.capturedTruncatedBytes,
        }),
        '',
        fenced(diff.text),
        '',
      );
    lines.push(
      'Original local API locator (requires the source application):',
      '',
      fenced(`/v1/events/${event.eventId}`),
      '',
    );
  }
  lines.push(
    '## Report notices and retention',
    '',
    'A downloaded copy is independent of the local database. Later deletion, disconnect or permission changes cannot revoke an already downloaded file. This report grants no team access and uploads nothing.',
    '',
  );
  for (const notice of report.notices) lines.push(fenced(notice), '');
  const markdown = `${lines.join('\n').trimEnd()}\n`;
  if (Buffer.byteLength(markdown, 'utf8') > maximumMarkdownBytes)
    throw new DomainError(
      'HANDOVER_TOO_LARGE',
      'The download exceeds the portable file size limit.',
      413,
    );
  return markdown;
}
