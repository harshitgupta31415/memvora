import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import {
  AskRequestSchema,
  CreateRepositorySchema,
  CreateSessionSchema,
  CreateSessionNoteSchema,
  CreateSessionSynthesisSchema,
  DashboardSchema,
  DeleteConfirmationSchema,
  DeleteResponseSchema,
  EventAckSchema,
  EventBatchSchema,
  EventResponseSchema,
  HealthSchema,
  IdSchema,
  JobListSchema,
  JobResponseSchema,
  JobsQuerySchema,
  MeSchema,
  MemoryResponseSchema,
  RecallAnswerSchema,
  RepositoryListSchema,
  RepositoryResponseSchema,
  RepositorySourceRangeQuerySchema,
  RepositorySourceResponseSchema,
  RepositorySourceSearchResponseSchema,
  RetryJobSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SessionContextSchema,
  SessionNoteResponseSchema,
  SessionNotesPageSchema,
  SessionNotesQuerySchema,
  SessionNoteSearchResponseSchema,
  SessionRecapSchema,
  SessionSynthesisPreviewSchema,
  SessionSynthesisResponseSchema,
  SessionHandoverSchema,
  SessionHandoverDownloadSchema,
  SessionHandoverDownloadQuerySchema,
  SessionEventsPageSchema,
  SessionEventsQuerySchema,
  SessionListSchema,
  SessionDirectoryRequestSchema,
  SessionDirectoryPageSchema,
  SessionResponseSchema,
  SettingsSchema,
  SystemStatusSchema,
} from '@memvora/contracts';
import {
  captureLimits,
  DomainError,
  deriveSessionRecap,
  deriveSessionHandover,
  formatSessionHandoverMarkdown,
  getSystemStatus,
  LocalMemvora,
  observedLabel,
  runEnrichmentOnce,
  runSessionSynthesisOnce,
} from '@memvora/core';
import type { EvidenceEnricher, LocalEvidenceStore, SessionSynthesizer } from '@memvora/core';

const immutableEventBatch = Compile(EventBatchSchema);
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function allowedHost(value: string | undefined): boolean {
  if (!value) return false;
  if (/[\/\\@?#\s]/.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    return localHosts.has(url.hostname) && !url.username && !url.password && url.pathname === '/';
  } catch {
    return false;
  }
}
function allowedOrigin(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      localHosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
function matchesToken(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const token = Buffer.from(expected);
  return supplied.length === token.length && timingSafeEqual(supplied, token);
}
export type AppOptions = {
  logger?: boolean;
  store?: LocalEvidenceStore;
  token?: string;
  embeddedWorker?: boolean;
  enricher?: EvidenceEnricher;
  synthesis?: SessionSynthesizer;
  registerIntegrations?: (app: FastifyInstance, service: LocalMemvora) => void;
};

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.body', 'res.body'] }
      : false,
    bodyLimit: captureLimits.batchBytes,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();
  const service = options.store ? new LocalMemvora(options.store) : undefined;
  const envelope = (code: string, message: string, requestId: string, retryable = false) => ({
    error: { code, message, requestId, retryable },
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!allowedHost(request.headers.host) || !allowedOrigin(request.headers.origin))
      return reply
        .code(403)
        .send(
          envelope(
            'LOCAL_ORIGIN_REQUIRED',
            'This local API accepts only trusted loopback requests.',
            request.id,
          ),
        );
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/v1/system/status') return;
    if (!service || !options.token || options.token.length < 32)
      return reply
        .code(503)
        .send(
          envelope(
            'LOCAL_NOT_CONFIGURED',
            'The local product store and credential are not configured.',
            request.id,
            true,
          ),
        );
    if (!matchesToken(request.headers.authorization, options.token))
      return reply
        .code(401)
        .send(envelope('UNAUTHENTICATED', 'A valid local credential is required.', request.id));
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError)
      return reply
        .code(error.statusCode)
        .send(envelope(error.code, error.message, request.id, error.retryable));
    const transportError =
      error && typeof error === 'object'
        ? (error as { validation?: unknown; statusCode?: number })
        : {};
    if (transportError.validation)
      return reply
        .code(400)
        .send(
          envelope(
            'INVALID_REQUEST',
            'The request does not match the documented contract.',
            request.id,
          ),
        );
    if (transportError.statusCode === 413)
      return reply
        .code(413)
        .send(
          envelope('REQUEST_TOO_LARGE', 'Request exceeds the configured byte limit.', request.id),
        );
    if (transportError.statusCode === 400)
      return reply
        .code(400)
        .send(envelope('INVALID_REQUEST', 'The request could not be parsed.', request.id));
    app.log.error({ code: 'INTERNAL_ERROR', requestId: request.id }, 'Local request failed');
    return reply
      .code(500)
      .send(
        envelope(
          'INTERNAL_ERROR',
          'The local operation failed. No partial acknowledgement was issued.',
          request.id,
          true,
        ),
      );
  });
  app.get('/health', { schema: { response: { 200: HealthSchema } } }, async () => ({
    status: 'ok' as const,
    service: 'memvora-api' as const,
  }));
  app.get('/v1/system/status', { schema: { response: { 200: SystemStatusSchema } } }, async () =>
    getSystemStatus({ local: Boolean(service) }),
  );
  if (!service || !options.store) return app;
  const store = options.store;
  const idParams = Type.Object({ id: IdSchema }, { additionalProperties: false });
  const listQuery = Type.Object(
    {
      repositoryId: Type.Optional(IdSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  );
  app.get('/ready', async () => {
    service.context();
    return { status: 'ready', mode: 'local', storage: 'sqlite' };
  });
  app.get('/v1/me', { schema: { response: { 200: MeSchema } } }, async () => service.context());
  app.get('/v1/dashboard', { schema: { response: { 200: DashboardSchema } } }, async () =>
    store.dashboard(service.context()),
  );
  app.get('/v1/settings', { schema: { response: { 200: SettingsSchema } } }, async () => {
    service.context();
    return {
      mode: 'local' as const,
      storage: { adapter: 'sqlite' as const, path: store.path },
      enrichment: {
        mode: options.enricher ? ('ai' as const) : ('observed' as const),
        label: options.enricher ? 'Configured AI enrichment with source validation' : observedLabel,
        status: options.enricher ? ('configured' as const) : ('ready' as const),
      },
      configuration: {
        github:
          'Explicit imports use a configured private GitHub App connection or existing local GitHub CLI access. Connection status is shown separately.',
        ai: options.enricher
          ? 'A summary provider is configured; failed jobs remain visible.'
          : 'Not configured; deterministic observed summaries are available.',
      },
      limits: captureLimits,
    };
  });
  app.get(
    '/v1/repositories',
    { schema: { response: { 200: RepositoryListSchema } } },
    async () => ({ items: store.repositories(service.context()) }),
  );
  app.post(
    '/v1/repositories',
    { schema: { body: CreateRepositorySchema, response: { 201: RepositoryResponseSchema } } },
    async (request, reply) =>
      reply.code(201).send({ repository: service.createRepository(request.body) }),
  );
  app.get(
    '/v1/repositories/:id',
    { schema: { params: idParams, response: { 200: RepositoryResponseSchema } } },
    async (request) => ({ repository: service.getRepository(request.params.id) }),
  );
  app.get(
    '/v1/sessions',
    { schema: { querystring: listQuery, response: { 200: SessionListSchema } } },
    async (request) => ({
      items: store.sessions(service.context(), request.query.repositoryId, request.query.limit),
    }),
  );
  app.post(
    '/v1/sessions/search',
    {
      schema: {
        body: SessionDirectoryRequestSchema,
        querystring: Type.Object({}, { additionalProperties: false }),
        response: { 200: SessionDirectoryPageSchema },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return store.findSessions(service.context(), request.body);
    },
  );
  app.post(
    '/v1/sessions',
    { schema: { body: CreateSessionSchema, response: { 201: SessionResponseSchema } } },
    async (request, reply) =>
      reply.code(201).send({ session: store.createSession(service.context(), request.body) }),
  );
  app.get(
    '/v1/sessions/:id/synthesis/preview',
    {
      schema: {
        params: idParams,
        querystring: Type.Object({}, { additionalProperties: false }),
        response: { 200: SessionSynthesisPreviewSchema },
      },
    },
    async (request) =>
      store.getSessionSynthesisPreview(
        service.context(),
        request.params.id,
        options.synthesis?.configuration ?? null,
      ),
  );
  app.get(
    '/v1/sessions/:id/synthesis',
    {
      schema: {
        params: idParams,
        querystring: Type.Object(
          { requestId: Type.Optional(IdSchema) },
          { additionalProperties: false },
        ),
        response: { 200: SessionSynthesisResponseSchema },
      },
    },
    async (request) =>
      store.getSessionSynthesis(
        service.context(),
        request.params.id,
        options.synthesis?.configuration ?? null,
        request.query.requestId,
      ),
  );
  app.post(
    '/v1/sessions/:id/synthesis',
    {
      schema: {
        params: idParams,
        querystring: Type.Object({}, { additionalProperties: false }),
        body: CreateSessionSynthesisSchema,
        response: { 200: SessionSynthesisResponseSchema, 202: SessionSynthesisResponseSchema },
      },
    },
    async (request, reply) => {
      const configuration = options.synthesis?.configuration ?? null;
      const result = store.requestSessionSynthesis(
        service.context(),
        request.params.id,
        request.body,
        configuration,
      );
      return reply
        .code(result.created ? 202 : 200)
        .send({ sessionId: request.params.id, configuration, request: result.request });
    },
  );
  app.get(
    '/v1/sessions/:id',
    { schema: { params: idParams, response: { 200: SessionContextSchema } } },
    async (request) => store.getSession(service.context(), request.params.id),
  );
  app.get(
    '/v1/sessions/:id/events',
    {
      schema: {
        params: idParams,
        querystring: SessionEventsQuerySchema,
        response: { 200: SessionEventsPageSchema },
      },
    },
    async (request) =>
      store.getSessionEvents(service.context(), request.params.id, { ...request.query }),
  );
  app.get(
    '/v1/sessions/:id/recap',
    {
      schema: {
        params: idParams,
        querystring: Type.Object({}, { additionalProperties: false }),
        response: { 200: SessionRecapSchema },
      },
    },
    async (request) =>
      deriveSessionRecap(store.getSessionRecapEvidence(service.context(), request.params.id)),
  );
  app.get(
    '/v1/sessions/:id/handover',
    {
      schema: {
        params: idParams,
        querystring: Type.Object({}, { additionalProperties: false }),
        response: { 200: SessionHandoverSchema },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return deriveSessionHandover(
        store.getSessionHandoverEvidence(service.context(), request.params.id),
      );
    },
  );
  app.get(
    '/v1/sessions/:id/handover/download',
    {
      schema: {
        params: idParams,
        querystring: SessionHandoverDownloadQuerySchema,
        response: { 200: SessionHandoverDownloadSchema },
      },
    },
    async (request, reply) => {
      const report = deriveSessionHandover(
        store.getSessionHandoverEvidence(service.context(), request.params.id),
      );
      const format = request.query.format ?? 'markdown';
      const content =
        format === 'json'
          ? `${JSON.stringify(report, null, 2)}\n`
          : formatSessionHandoverMarkdown(report);
      if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024)
        throw new DomainError(
          'HANDOVER_TOO_LARGE',
          'The download exceeds the portable file size limit.',
          413,
        );
      reply.header('cache-control', 'no-store');
      return {
        format,
        filename: `memvora-handover-${report.session.id}.${format === 'json' ? 'json' : 'md'}`,
        mediaType: format === 'json' ? ('application/json' as const) : ('text/markdown' as const),
        content,
      };
    },
  );
  app.get(
    '/v1/sessions/:id/notes',
    {
      schema: {
        params: idParams,
        querystring: SessionNotesQuerySchema,
        response: { 200: SessionNotesPageSchema },
      },
    },
    async (request) =>
      store.sessionNotes(service.context(), request.params.id, { ...request.query }),
  );
  app.post(
    '/v1/sessions/:id/notes',
    {
      schema: {
        params: idParams,
        body: CreateSessionNoteSchema,
        response: { 200: SessionNoteResponseSchema, 201: SessionNoteResponseSchema },
      },
    },
    async (request, reply) => {
      const result = store.createSessionNote(service.context(), request.params.id, request.body);
      return reply.code(result.created ? 201 : 200).send({ note: result.note });
    },
  );
  app.get(
    '/v1/session-notes/:id',
    { schema: { params: idParams, response: { 200: SessionNoteResponseSchema } } },
    async (request) => ({ note: store.getSessionNote(service.context(), request.params.id) }),
  );
  app.post(
    '/v1/session-notes/search',
    { schema: { body: SearchRequestSchema, response: { 200: SessionNoteSearchResponseSchema } } },
    async (request) => ({
      items: store.searchSessionNotes(service.context(), request.body),
      requestId: request.id,
    }),
  );
  app.post(
    '/v1/sessions/:id/close',
    { schema: { params: idParams, response: { 200: SessionResponseSchema } } },
    async (request) => ({ session: store.closeSession(service.context(), request.params.id) }),
  );
  app.post(
    '/v1/events/batch',
    {
      schema: { body: EventBatchSchema, response: { 200: EventAckSchema } },
      // Event JSON participates in immutable retry digests. Validation must never
      // coerce null/scalars, insert defaults, strip fields or otherwise change it.
      // This route has only a body validator; query routes retain normal coercion.
      validatorCompiler: () => (data: unknown) => {
        try {
          if (immutableEventBatch.Check(data)) return { value: data };
        } catch {
          // Return a safe validation result, never schema diagnostics containing data.
        }
        return {
          error: [
            {
              keyword: 'eventBatch',
              instancePath: '',
              schemaPath: '#',
              params: {},
              message: 'must match the immutable event-batch contract',
            },
          ],
        };
      },
    },
    async (request) => ({
      acknowledgedEventIds: service.ingest(request.body.events),
      requestId: request.id,
    }),
  );
  app.get(
    '/v1/events/:id',
    { schema: { params: idParams, response: { 200: EventResponseSchema } } },
    async (request) => ({ event: store.getEvent(service.context(), request.params.id) }),
  );
  app.post(
    '/v1/memories/search',
    { schema: { body: SearchRequestSchema, response: { 200: SearchResponseSchema } } },
    async (request) => ({
      items: store.search(service.context(), request.body),
      requestId: request.id,
    }),
  );
  app.get(
    '/v1/memories/:id',
    { schema: { params: idParams, response: { 200: MemoryResponseSchema } } },
    async (request) => ({ memory: store.getMemory(service.context(), request.params.id) }),
  );
  app.post(
    '/v1/repository-sources/search',
    {
      schema: {
        body: SearchRequestSchema,
        response: { 200: RepositorySourceSearchResponseSchema },
      },
    },
    async (request) => ({
      items: store.searchRepositorySources(service.context(), request.body),
      requestId: request.id,
    }),
  );
  app.get(
    '/v1/repository-sources/:id',
    {
      schema: {
        params: idParams,
        querystring: RepositorySourceRangeQuerySchema,
        response: { 200: RepositorySourceResponseSchema },
      },
    },
    async (request) => ({
      document: store.getRepositorySource(service.context(), request.params.id, request.query),
    }),
  );
  app.post(
    '/v1/ask',
    { schema: { body: AskRequestSchema, response: { 200: RecallAnswerSchema } } },
    async (request) => service.ask(request.body, request.id),
  );
  app.get(
    '/v1/jobs',
    { schema: { querystring: JobsQuerySchema, response: { 200: JobListSchema } } },
    async (request) => ({ items: store.jobs(service.context(), request.query) }),
  );
  app.post(
    '/v1/jobs/:id/retry',
    { schema: { params: idParams, body: RetryJobSchema, response: { 202: JobResponseSchema } } },
    async (request, reply) =>
      reply.code(202).send({ job: store.retryJob(service.context(), request.params.id) }),
  );
  app.delete(
    '/v1/sessions/:id',
    {
      schema: {
        params: idParams,
        body: DeleteConfirmationSchema,
        response: { 200: DeleteResponseSchema },
      },
    },
    async (request) => {
      store.deleteSession(service.context(), request.params.id);
      return { deleted: true as const, id: request.params.id };
    },
  );
  app.delete(
    '/v1/repositories/:id',
    {
      schema: {
        params: idParams,
        body: DeleteConfirmationSchema,
        response: { 200: DeleteResponseSchema },
      },
    },
    async (request) => {
      store.deleteRepository(service.context(), request.params.id);
      return { deleted: true as const, id: request.params.id };
    },
  );
  app.delete(
    '/v1/workspace',
    { schema: { body: DeleteConfirmationSchema, response: { 200: DeleteResponseSchema } } },
    async () => {
      const context = service.context();
      store.deleteWorkspace(context);
      return { deleted: true as const, id: context.workspace.id };
    },
  );
  options.registerIntegrations?.(app as unknown as FastifyInstance, service);
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let preferSynthesis = true;
  if (options.embeddedWorker ?? true)
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        const synthesisFirst = preferSynthesis;
        preferSynthesis = !preferSynthesis;
        void (async () => {
          if (synthesisFirst) {
            if (!(await runSessionSynthesisOnce(store, options.synthesis)))
              await runEnrichmentOnce(store, options.enricher);
          } else if (!(await runEnrichmentOnce(store, options.enricher)))
            await runSessionSynthesisOnce(store, options.synthesis);
        })()
          .catch(() => {
            app.log.warn({ code: 'WORKER_POLL_FAILED' }, 'Local enrichment poll failed');
          })
          .finally(() => {
            busy = false;
          });
      }, 750);
      timer.unref();
    });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    while (busy) await new Promise((done) => setTimeout(done, 50));
    store.close();
  });
  return app;
}
