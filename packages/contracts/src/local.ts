import Type from 'typebox';

const object = <T extends Record<string, Type.TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const IdSchema = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});
export const TimestampSchema = Type.String({ format: 'date-time' });
export const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

export const RepositorySchema = object({
  id: IdSchema,
  workspaceId: IdSchema,
  name: Type.String(),
  localPath: NullableStringSchema,
  remoteUrl: NullableStringSchema,
  status: Type.Literal('active'),
  createdAt: TimestampSchema,
});
export type Repository = Type.Static<typeof RepositorySchema>;
export const CreateRepositorySchema = object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  localPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  remoteUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
});
export type CreateRepository = Type.Static<typeof CreateRepositorySchema>;
export const RepositoryContextSchema = object({
  provider: Type.Literal('github'),
  fullName: Type.String({ maxLength: 300 }),
  defaultBranch: Type.String({ maxLength: 200 }),
  commitSha: NullableStringSchema,
  importedAt: TimestampSchema,
  files: Type.Array(
    object({
      path: Type.String({ maxLength: 1024 }),
      sha: Type.String({ maxLength: 100 }),
      size: Type.Integer({ minimum: 0 }),
      text: Type.String({ maxLength: 131072 }),
    }),
    { maxItems: 100 },
  ),
  issues: Type.Array(
    object({
      number: Type.Integer({ minimum: 1 }),
      title: Type.String({ maxLength: 1000 }),
      state: Type.String({ maxLength: 100 }),
      url: Type.String({ maxLength: 2048 }),
    }),
    { maxItems: 100 },
  ),
  pullRequests: Type.Array(
    object({
      number: Type.Integer({ minimum: 1 }),
      title: Type.String({ maxLength: 1000 }),
      state: Type.String({ maxLength: 100 }),
      url: Type.String({ maxLength: 2048 }),
    }),
    { maxItems: 100 },
  ),
});
export type RepositoryContext = Type.Static<typeof RepositoryContextSchema>;
export const RepositoryResponseSchema = object({ repository: RepositorySchema });
export const RepositoryListSchema = object({ items: Type.Array(RepositorySchema) });

export const SessionSchema = object({
  id: IdSchema,
  repositoryId: IdSchema,
  title: Type.String(),
  status: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
  createdAt: TimestampSchema,
  closedAt: Type.Union([TimestampSchema, Type.Null()]),
  eventCount: Type.Integer({ minimum: 0 }),
  memoryCount: Type.Integer({ minimum: 0 }),
});
export type Session = Type.Static<typeof SessionSchema>;
export const CreateSessionSchema = object({
  repositoryId: IdSchema,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export type CreateSession = Type.Static<typeof CreateSessionSchema>;
export const SessionResponseSchema = object({ session: SessionSchema });
export const SessionListSchema = object({ items: Type.Array(SessionSchema) });

export const EventSchema = object({
  eventId: IdSchema,
  repositoryId: IdSchema,
  sessionId: IdSchema,
  sequence: Type.Integer({ minimum: 1 }),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  command: object({
    executable: Type.String({ minLength: 1, maxLength: 4096 }),
    args: Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 256 }),
    shell: Type.String({ maxLength: 120 }),
  }),
  cwd: Type.String({ maxLength: 2048 }),
  git: object({
    commitSha: Type.Union([Type.String({ pattern: '^[a-fA-F0-9]{40,64}$' }), Type.Null()]),
    dirty: Type.Boolean(),
    error: Type.Optional(Type.String({ maxLength: 500 })),
  }),
  outcome: object({
    kind: Type.Union([
      Type.Literal('completed'),
      Type.Literal('spawn_failed'),
      Type.Literal('interrupted'),
      Type.Literal('incomplete'),
    ]),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: NullableStringSchema,
    error: Type.Optional(
      object({ code: Type.String({ maxLength: 100 }), message: Type.String({ maxLength: 1000 }) }),
    ),
  }),
  capture: object({
    complete: Type.Boolean(),
    truncatedBytes: Type.Integer({ minimum: 0 }),
    redacted: Type.Boolean(),
  }),
  output: Type.Array(
    object({
      stream: Type.Union([Type.Literal('stdout'), Type.Literal('stderr')]),
      ordinal: Type.Integer({ minimum: 0 }),
      text: Type.String({ maxLength: 131072 }),
    }),
    { maxItems: 512 },
  ),
  diffs: Type.Array(
    object({
      phase: Type.Union([Type.Literal('before'), Type.Literal('after')]),
      text: Type.String({ maxLength: 131072 }),
      truncatedBytes: Type.Integer({ minimum: 0 }),
    }),
    { maxItems: 2 },
  ),
});
export type CapturedEvent = Type.Static<typeof EventSchema>;
export const EventBatchSchema = object({
  schemaVersion: Type.Literal(1),
  events: Type.Array(EventSchema, { minItems: 1, maxItems: 50 }),
});
export type EventBatch = Type.Static<typeof EventBatchSchema>;
export const EventAckSchema = object({
  acknowledgedEventIds: Type.Array(IdSchema),
  requestId: Type.String(),
});
export type EventAck = Type.Static<typeof EventAckSchema>;
export const EventResponseSchema = object({ event: EventSchema });

export const CitationSchema = object({
  id: IdSchema,
  kind: Type.Literal('event'),
  repositoryId: IdSchema,
  locator: Type.String(),
});
export type Citation = Type.Static<typeof CitationSchema>;
export const MemorySchema = object({
  id: IdSchema,
  repositoryId: IdSchema,
  sessionId: IdSchema,
  title: Type.String(),
  summary: Type.String(),
  mode: Type.Union([Type.Literal('observed'), Type.Literal('ai')]),
  label: Type.String(),
  outcome: Type.String(),
  createdAt: TimestampSchema,
  steps: Type.Array(object({ text: Type.String(), sourceIds: Type.Array(IdSchema) })),
  sources: Type.Array(CitationSchema),
  uncertainty: Type.Array(Type.String()),
  provenance: Type.Optional(
    object({ provider: Type.String(), model: Type.String(), promptVersion: Type.String() }),
  ),
});
export type Memory = Type.Static<typeof MemorySchema>;
export const MemoryResponseSchema = object({ memory: MemorySchema });
export const SessionContextSchema = object({
  session: SessionSchema,
  events: Type.Array(EventSchema),
  memories: Type.Array(MemorySchema),
});
export type SessionContext = Type.Static<typeof SessionContextSchema>;
export const SearchRequestSchema = object({
  query: Type.String({ minLength: 1, maxLength: 2000 }),
  repositoryIds: Type.Optional(Type.Array(IdSchema, { maxItems: 20 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
export type SearchRequest = Type.Static<typeof SearchRequestSchema>;
export const SearchResponseSchema = object({
  items: Type.Array(MemorySchema),
  requestId: Type.String(),
});
export type SearchResponse = Type.Static<typeof SearchResponseSchema>;
export const AskRequestSchema = object({
  query: Type.String({ minLength: 1, maxLength: 2000 }),
  repositoryIds: Type.Optional(Type.Array(IdSchema, { maxItems: 20 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  sessionId: Type.Optional(IdSchema),
});
export type AskRequest = Type.Static<typeof AskRequestSchema>;
export const RecallAnswerSchema = object({
  status: Type.Union([Type.Literal('answered'), Type.Literal('insufficient_evidence')]),
  mode: Type.Union([Type.Literal('observed'), Type.Literal('ai'), Type.Literal('mixed')]),
  label: Type.String(),
  answer: Type.String(),
  steps: Type.Array(object({ text: Type.String(), sourceIds: Type.Array(IdSchema) })),
  sources: Type.Array(CitationSchema),
  uncertainty: Type.Array(Type.String()),
  requestId: Type.String(),
});
export type RecallAnswer = Type.Static<typeof RecallAnswerSchema>;

export const MeSchema = object({
  mode: Type.Literal('local'),
  user: object({ id: IdSchema, name: Type.String() }),
  workspace: object({
    id: IdSchema,
    name: Type.String(),
    generation: Type.Integer({ minimum: 1 }),
  }),
});
export type LocalContext = Type.Static<typeof MeSchema>;
export const DashboardSchema = object({
  mode: Type.Literal('local'),
  counts: object({
    repositories: Type.Integer({ minimum: 0 }),
    sessions: Type.Integer({ minimum: 0 }),
    events: Type.Integer({ minimum: 0 }),
    memories: Type.Integer({ minimum: 0 }),
    queuedJobs: Type.Integer({ minimum: 0 }),
    failedJobs: Type.Integer({ minimum: 0 }),
  }),
  recentSessions: Type.Array(SessionSchema),
});
export type Dashboard = Type.Static<typeof DashboardSchema>;
export const SettingsSchema = object({
  mode: Type.Literal('local'),
  storage: object({ adapter: Type.Literal('sqlite'), path: Type.String() }),
  enrichment: object({
    mode: Type.Union([Type.Literal('observed'), Type.Literal('ai')]),
    label: Type.String(),
    status: Type.Union([Type.Literal('ready'), Type.Literal('configured')]),
  }),
  configuration: object({ github: Type.String(), ai: Type.String() }),
  limits: object({
    batchEvents: Type.Integer(),
    batchBytes: Type.Integer(),
    eventBytes: Type.Integer(),
    outputBytes: Type.Integer(),
  }),
});
export type LocalSettings = Type.Static<typeof SettingsSchema>;
export const DeleteConfirmationSchema = object({ confirm: Type.Literal(true) });
export const DeleteResponseSchema = object({ deleted: Type.Literal(true), id: IdSchema });
export const ErrorSchema = object({
  error: object({
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    retryable: Type.Boolean(),
  }),
});
