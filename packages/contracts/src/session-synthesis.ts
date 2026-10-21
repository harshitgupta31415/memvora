import Type from 'typebox';
import { CitationSchema, IdSchema, SessionNoteCitationSchema, TimestampSchema } from './local.js';

const object = <T extends Record<string, Type.TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const SessionSynthesisConfigurationSchema = object({
  provider: Type.String({ minLength: 1, maxLength: 200 }),
  model: Type.String({ minLength: 1, maxLength: 200 }),
  fingerprint: hash,
  promptVersion: Type.Literal('session-analysis-v1'),
});
export type SessionSynthesisConfiguration = Type.Static<typeof SessionSynthesisConfigurationSchema>;
export const SessionSynthesisCoverageSchema = object({
  totalEvents: Type.Integer({ minimum: 0 }),
  includedEvents: Type.Integer({ minimum: 0, maximum: 140 }),
  omittedEvents: Type.Integer({ minimum: 0 }),
  totalNotes: Type.Integer({ minimum: 0 }),
  includedNotes: Type.Integer({ minimum: 0, maximum: 10 }),
  omittedNotes: Type.Integer({ minimum: 0 }),
  excerptLimit: Type.Integer({ minimum: 0, maximum: 1200 }),
  inputByteLimit: Type.Literal(65536),
  repositoryFilesIncluded: Type.Literal(false),
  derivedMemoriesIncluded: Type.Literal(false),
});
export type SessionSynthesisCoverage = Type.Static<typeof SessionSynthesisCoverageSchema>;
export const SessionSynthesisInputSchema = object({
  version: Type.Literal(1),
  sessionId: IdSchema,
  repositoryId: IdSchema,
  title: Type.String({ maxLength: 200 }),
  sessionStatus: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
  coverage: SessionSynthesisCoverageSchema,
  events: Type.Array(
    object({
      id: IdSchema,
      sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      endedAt: TimestampSchema,
      command: Type.String({ maxLength: 512 }),
      outcome: object({
        kind: Type.String({ maxLength: 30 }),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
      }),
      commitSha: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
      output: Type.String({ maxLength: 1200 }),
      diff: Type.String({ maxLength: 1200 }),
      captureIncomplete: Type.Boolean(),
      excerpted: Type.Boolean(),
    }),
    { maxItems: 140 },
  ),
  notes: Type.Array(
    object({
      id: IdSchema,
      kind: Type.Union([
        Type.Literal('note'),
        Type.Literal('decision'),
        Type.Literal('resolution'),
      ]),
      authorName: Type.String({ maxLength: 120 }),
      createdAt: TimestampSchema,
      body: Type.String({ maxLength: 1200 }),
      eventIds: Type.Array(IdSchema, { maxItems: 10 }),
      excerpted: Type.Boolean(),
    }),
    { maxItems: 10 },
  ),
});
export type SessionSynthesisInput = Type.Static<typeof SessionSynthesisInputSchema>;
const claim = object({
  text: Type.String({ minLength: 1, maxLength: 1200 }),
  sourceIds: Type.Array(IdSchema, { minItems: 1, maxItems: 10 }),
});
export const SessionSynthesisAnalysisSchema = object({
  overview: claim,
  hypotheses: Type.Array(claim, { maxItems: 6 }),
  unresolvedQuestions: Type.Array(claim, { maxItems: 6 }),
  suggestedChecks: Type.Array(claim, { maxItems: 6 }),
  uncertainty: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), {
    minItems: 1,
    maxItems: 8,
  }),
});
export type SessionSynthesisAnalysis = Type.Static<typeof SessionSynthesisAnalysisSchema>;
export const SessionSynthesisSourceSchema = Type.Union([CitationSchema, SessionNoteCitationSchema]);
export type SessionSynthesisSource = Type.Static<typeof SessionSynthesisSourceSchema>;
export const SessionSynthesisRequestSchema = object({
  id: IdSchema,
  sessionId: IdSchema,
  repositoryId: IdSchema,
  status: Type.Union([
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('ready'),
    Type.Literal('failed'),
    Type.Literal('superseded'),
  ]),
  attempts: Type.Integer({ minimum: 0, maximum: 1 }),
  createdAt: TimestampSchema,
  startedAt: Type.Union([TimestampSchema, Type.Null()]),
  finishedAt: Type.Union([TimestampSchema, Type.Null()]),
  inputHash: hash,
  configuration: SessionSynthesisConfigurationSchema,
  coverage: SessionSynthesisCoverageSchema,
  sources: Type.Array(SessionSynthesisSourceSchema, { maxItems: 150 }),
  stale: Type.Boolean(),
  failureCode: Type.Union([
    Type.Literal('PROVIDER_FAILED'),
    Type.Literal('INTERRUPTED'),
    Type.Literal('INPUT_CHANGED'),
    Type.Literal('CONFIGURATION_CHANGED'),
    Type.Null(),
  ]),
  analysis: Type.Union([SessionSynthesisAnalysisSchema, Type.Null()]),
});
export type SessionSynthesisRequest = Type.Static<typeof SessionSynthesisRequestSchema>;
export const SessionSynthesisPreviewSchema = object({
  sessionId: IdSchema,
  repositoryId: IdSchema,
  availability: Type.Union([
    Type.Literal('available'),
    Type.Literal('disabled'),
    Type.Literal('insufficient_evidence'),
  ]),
  configuration: Type.Union([SessionSynthesisConfigurationSchema, Type.Null()]),
  inputHash: Type.Union([hash, Type.Null()]),
  inputBytes: Type.Integer({ minimum: 0, maximum: 65536 }),
  coverage: SessionSynthesisCoverageSchema,
  sourceIds: Type.Array(IdSchema, { maxItems: 150 }),
  notices: Type.Array(Type.String({ maxLength: 800 }), { maxItems: 8 }),
});
export type SessionSynthesisPreview = Type.Static<typeof SessionSynthesisPreviewSchema>;
export const CreateSessionSynthesisSchema = object({
  requestId: IdSchema,
  expectedInputHash: hash,
});
export type CreateSessionSynthesis = Type.Static<typeof CreateSessionSynthesisSchema>;
export const SessionSynthesisResponseSchema = object({
  sessionId: IdSchema,
  configuration: Type.Union([SessionSynthesisConfigurationSchema, Type.Null()]),
  request: Type.Union([SessionSynthesisRequestSchema, Type.Null()]),
});
export type SessionSynthesisResponse = Type.Static<typeof SessionSynthesisResponseSchema>;
