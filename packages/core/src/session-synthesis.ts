import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { Check } from 'typebox/value';
import {
  SessionSynthesisAnalysisSchema,
  SessionSynthesisConfigurationSchema,
  SessionSynthesisInputSchema,
  SessionSynthesisPreviewSchema,
  SessionSynthesisResponseSchema,
  type SessionSynthesisAnalysis,
  type SessionSynthesisConfiguration,
  type SessionSynthesisInput,
  type SessionSynthesisPreview,
  type SessionSynthesisResponse,
  type SessionSynthesisSource,
} from '@memvora/contracts';
import { DomainError, redactText, type SessionHandoverEvidence } from './local-service.js';
import { deriveSessionHandover } from './session-handover.js';
import { sessionNoteCitation } from './session-notes.js';
import type { SessionSynthesizer, SessionSynthesisStore } from './session-synthesis-types.js';

export const sessionSynthesisPromptVersion = 'session-analysis-v1' as const;
export const sessionSynthesisInputByteLimit = 65_536;
export const sessionSynthesisAnalysisByteLimit = 24_576;

function invalid(): never {
  throw new DomainError(
    'INVALID_SYNTHESIS_EVIDENCE',
    'The investigation analysis does not match its authorized evidence.',
    502,
  );
}
function clean(value: string): string {
  return redactText(
    stripVTControlCharacters(value)
      .replace(/\r\n?/gu, '\n')
      .replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
        '',
      ),
  );
}
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let text = value.slice(0, Math.max(0, limit - 1));
  if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
  return limit ? `${text}…` : '';
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function coverageValid(value: SessionSynthesisInput['coverage']): boolean {
  return (
    value.totalEvents === value.includedEvents + value.omittedEvents &&
    value.totalNotes === value.includedNotes + value.omittedNotes
  );
}
export function buildSessionSynthesisInput(evidence: SessionHandoverEvidence): {
  input: SessionSynthesisInput;
  sources: SessionSynthesisSource[];
} {
  const report = deriveSessionHandover(evidence);
  const sources: SessionSynthesisSource[] = [
    ...report.events.map((event) => ({
      id: event.eventId,
      kind: 'event' as const,
      repositoryId: report.repository.id,
      locator: `/v1/events/${event.eventId}`,
    })),
    ...report.notes.map(sessionNoteCitation),
  ];
  for (const limit of [1200, 600, 300, 160, 80, 40, 0]) {
    const commandLimit = Math.min(512, Math.max(32, limit));
    const input: SessionSynthesisInput = {
      version: 1,
      sessionId: report.session.id,
      repositoryId: report.repository.id,
      title: clean(report.session.title),
      sessionStatus: report.session.status,
      coverage: {
        totalEvents: report.coverage.totalEvents,
        includedEvents: report.coverage.includedEvents,
        omittedEvents: report.coverage.omittedEvents,
        totalNotes: report.coverage.totalNotes,
        includedNotes: report.coverage.includedNotes,
        omittedNotes: report.coverage.omittedNotes,
        excerptLimit: limit,
        inputByteLimit: 65536,
        repositoryFilesIncluded: false,
        derivedMemoriesIncluded: false,
      },
      events: report.events.map((event) => {
        const command = clean(event.commandExcerpt);
        const output = clean(
          [
            event.outcome.error
              ? `[process error ${event.outcome.error.code}] ${event.outcome.error.message}`
              : '',
            event.outcome.signal ? `[signal ${event.outcome.signal}]` : '',
            event.outputExcerpt,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        const diff = clean(event.diffs.map((item) => `[${item.phase}] ${item.text}`).join('\n'));
        return {
          id: event.eventId,
          sequence: event.sequence,
          endedAt: event.endedAt,
          command: clip(command, commandLimit),
          outcome: { kind: event.outcome.kind, exitCode: event.outcome.exitCode },
          commitSha: event.git.commitSha,
          output: clip(output, limit),
          diff: clip(diff, limit),
          captureIncomplete:
            !event.capture.complete ||
            event.capture.truncatedBytes > 0 ||
            Boolean(event.git.error) ||
            event.diffs.some((item) => item.capturedTruncatedBytes > 0),
          excerpted:
            event.commandTruncated ||
            event.outputTruncated ||
            event.diffs.some((item) => item.excerptTruncated) ||
            command.length > commandLimit ||
            output.length > limit ||
            diff.length > limit,
        };
      }),
      notes: report.notes.map((note) => ({
        id: note.id,
        kind: note.kind,
        authorName: clean(note.author.name),
        createdAt: note.createdAt,
        body: clip(clean(note.body), limit),
        eventIds: note.sources.map((source) => source.id),
        excerpted: note.body.length > limit,
      })),
    };
    if (bytes(input) > sessionSynthesisInputByteLimit) continue;
    if (
      !Check(SessionSynthesisInputSchema, input) ||
      !coverageValid(input.coverage) ||
      new Set(sources.map((source) => source.id)).size !== sources.length
    )
      invalid();
    return { input, sources };
  }
  throw new DomainError(
    'SYNTHESIS_INPUT_TOO_LARGE',
    'The selected evidence identities exceed the analysis input limit.',
    413,
  );
}

export function sessionSynthesisInputHash(
  input: SessionSynthesisInput,
  configuration: SessionSynthesisConfiguration,
  revision: string,
): string {
  if (
    !Check(SessionSynthesisInputSchema, input) ||
    !Check(SessionSynthesisConfigurationSchema, configuration) ||
    bytes(input) > sessionSynthesisInputByteLimit ||
    typeof revision !== 'string' ||
    revision.length > 4096
  )
    invalid();
  return createHash('sha256')
    .update(
      JSON.stringify({
        input,
        configuration: {
          provider: configuration.provider,
          model: configuration.model,
          fingerprint: configuration.fingerprint,
          promptVersion: configuration.promptVersion,
        },
        revision,
      }),
    )
    .digest('hex');
}

export function validateSessionSynthesisAnalysis(
  value: unknown,
  input: SessionSynthesisInput,
): SessionSynthesisAnalysis {
  if (
    !Check(SessionSynthesisAnalysisSchema, value) ||
    bytes(value) > sessionSynthesisAnalysisByteLimit
  )
    invalid();
  const allowed = new Set([
    ...input.events.map((event) => event.id),
    ...input.notes.map((note) => note.id),
  ]);
  const claims = [
    value.overview,
    ...value.hypotheses,
    ...value.unresolvedQuestions,
    ...value.suggestedChecks,
  ];
  if (
    claims.some(
      (claim) =>
        new Set(claim.sourceIds).size !== claim.sourceIds.length ||
        claim.sourceIds.some((id) => !allowed.has(id)),
    )
  )
    invalid();
  const result: SessionSynthesisAnalysis = {
    overview: { text: clean(value.overview.text), sourceIds: [...value.overview.sourceIds] },
    hypotheses: value.hypotheses.map((claim) => ({
      text: clean(claim.text),
      sourceIds: [...claim.sourceIds],
    })),
    unresolvedQuestions: value.unresolvedQuestions.map((claim) => ({
      text: clean(claim.text),
      sourceIds: [...claim.sourceIds],
    })),
    suggestedChecks: value.suggestedChecks.map((claim) => ({
      text: clean(claim.text),
      sourceIds: [...claim.sourceIds],
    })),
    uncertainty: value.uncertainty.map(clean),
  };
  if (
    !Check(SessionSynthesisAnalysisSchema, result) ||
    bytes(result) > sessionSynthesisAnalysisByteLimit ||
    [
      result.overview,
      ...result.hypotheses,
      ...result.unresolvedQuestions,
      ...result.suggestedChecks,
    ].some((claim) => !claim.text.trim()) ||
    result.uncertainty.some((text) => !text.trim())
  )
    invalid();
  return result;
}

export function validateSessionSynthesisPreview(
  value: unknown,
  sessionId: string,
): SessionSynthesisPreview {
  if (
    !Check(SessionSynthesisPreviewSchema, value) ||
    value.sessionId !== sessionId ||
    !coverageValid(value.coverage) ||
    new Set(value.sourceIds).size !== value.sourceIds.length ||
    value.sourceIds.length !== value.coverage.includedEvents + value.coverage.includedNotes
  )
    invalid();
  if (
    value.availability === 'disabled'
      ? value.configuration !== null || value.inputHash !== null
      : value.configuration === null ||
        value.inputHash === null ||
        (value.availability === 'available') !== value.coverage.totalEvents >= 2
  )
    invalid();
  return value;
}

export function validateSessionSynthesisResponse(
  value: unknown,
  sessionId: string,
  requestId?: string,
): SessionSynthesisResponse {
  if (!Check(SessionSynthesisResponseSchema, value) || value.sessionId !== sessionId) invalid();
  const request = value.request;
  if (!request) {
    if (requestId !== undefined) invalid();
    return value;
  }
  if (
    request.sessionId !== sessionId ||
    (requestId !== undefined && request.id !== requestId) ||
    !coverageValid(request.coverage)
  )
    invalid();
  const sources = new Map(request.sources.map((source) => [source.id, source]));
  if (
    sources.size !== request.sources.length ||
    request.sources.filter((source) => source.kind === 'event').length !==
      request.coverage.includedEvents ||
    request.sources.filter((source) => source.kind === 'session_note').length !==
      request.coverage.includedNotes
  )
    invalid();
  for (const source of request.sources) {
    if (
      source.repositoryId !== request.repositoryId ||
      source.locator !==
        (source.kind === 'event' ? `/v1/events/${source.id}` : `/v1/session-notes/${source.id}`) ||
      (source.kind === 'session_note' && source.sessionId !== sessionId)
    )
      invalid();
  }
  if (
    (!value.configuration ||
      value.configuration.fingerprint !== request.configuration.fingerprint) &&
    !request.stale
  )
    invalid();
  if (request.status === 'ready') {
    if (
      !request.analysis ||
      request.attempts !== 1 ||
      request.startedAt === null ||
      request.finishedAt === null ||
      request.failureCode !== null ||
      bytes(request.analysis) > sessionSynthesisAnalysisByteLimit
    )
      invalid();
    const claims = [
      request.analysis.overview,
      ...request.analysis.hypotheses,
      ...request.analysis.unresolvedQuestions,
      ...request.analysis.suggestedChecks,
    ];
    if (
      claims.some(
        (claim) =>
          new Set(claim.sourceIds).size !== claim.sourceIds.length ||
          claim.sourceIds.some((id) => !sources.has(id)),
      )
    )
      invalid();
  } else {
    if (request.analysis !== null) invalid();
    if (
      request.status === 'queued' &&
      (request.attempts !== 0 ||
        request.startedAt !== null ||
        request.finishedAt !== null ||
        request.failureCode !== null)
    )
      invalid();
    if (
      request.status === 'running' &&
      (request.attempts !== 1 ||
        request.startedAt === null ||
        request.finishedAt !== null ||
        request.failureCode !== null)
    )
      invalid();
    if (
      (request.status === 'failed' || request.status === 'superseded') &&
      (request.finishedAt === null || request.failureCode === null)
    )
      invalid();
    if (
      request.status === 'failed' &&
      (request.attempts !== 1 ||
        request.startedAt === null ||
        !['PROVIDER_FAILED', 'INTERRUPTED'].includes(request.failureCode!))
    )
      invalid();
    if (
      request.status === 'superseded' &&
      ((request.attempts === 0) !== (request.startedAt === null) ||
        !['INPUT_CHANGED', 'CONFIGURATION_CHANGED'].includes(request.failureCode!))
    )
      invalid();
  }
  return value;
}

/** One explicit durable request may cause one provider attempt; reads never call this. */
export async function runSessionSynthesisOnce(
  store: SessionSynthesisStore,
  synthesizer?: SessionSynthesizer,
): Promise<boolean> {
  const job = store.claimSessionSynthesis(synthesizer?.configuration ?? null);
  if (!job) return false;
  if (!synthesizer || job.configuration.fingerprint !== synthesizer.configuration.fingerprint) {
    store.failSessionSynthesis(job);
    return true;
  }
  try {
    const analysis = validateSessionSynthesisAnalysis(
      await synthesizer.synthesize(structuredClone(job.input)),
      job.input,
    );
    store.completeSessionSynthesis(job, analysis);
  } catch {
    store.failSessionSynthesis(job);
  }
  return true;
}
