import { createHash, randomUUID } from 'node:crypto';
import type {
  AskRequest,
  CapturedEvent,
  CreateRepository,
  CreateSession,
  Dashboard,
  LocalContext,
  Memory,
  RecallAnswer,
  Repository,
  RepositoryContext,
  SearchRequest,
  Session,
  SessionContext,
} from '@memvora/contracts';

export const captureLimits = {
  batchEvents: 50,
  batchBytes: 2 * 1024 * 1024,
  eventBytes: 512 * 1024,
  outputBytes: 256 * 1024,
} as const;
export const observedLabel = 'Observed evidence summary — deterministic, not AI-generated';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export type AcceptedEvent = { event: CapturedEvent; digest: string };
export type EnrichmentJob = {
  id: string;
  leaseToken: string;
  event: CapturedEvent;
  workspaceGeneration: number;
  repositoryGeneration: number;
  sessionGeneration: number;
  attempts: number;
};
/** The adapter must apply scope predicates inside every read and atomic write. */
export interface LocalEvidenceStore {
  readonly path: string;
  context(): LocalContext;
  repositories(context: LocalContext): Repository[];
  createRepository(context: LocalContext, input: CreateRepository): Repository;
  getRepository(context: LocalContext, id: string): Repository;
  saveRepositoryContext(context: LocalContext, id: string, value: RepositoryContext): void;
  getRepositoryContext(context: LocalContext, id: string): RepositoryContext | null;
  sessions(context: LocalContext, repositoryId?: string, limit?: number): Session[];
  createSession(context: LocalContext, input: CreateSession): Session;
  getSession(context: LocalContext, id: string): SessionContext;
  closeSession(context: LocalContext, id: string): Session;
  getEvent(context: LocalContext, id: string): CapturedEvent;
  neighborEvents(context: LocalContext, eventId: string, radius?: number): CapturedEvent[];
  recentSession(context: LocalContext, repositoryIds?: string[]): SessionContext | null;
  ingest(context: LocalContext, events: AcceptedEvent[]): string[];
  search(context: LocalContext, input: SearchRequest, sessionId?: string): Memory[];
  getMemory(context: LocalContext, id: string): Memory;
  dashboard(context: LocalContext): Dashboard;
  deleteSession(context: LocalContext, id: string): void;
  deleteRepository(context: LocalContext, id: string): void;
  deleteWorkspace(context: LocalContext): void;
  claimJob(): EnrichmentJob | null;
  completeJob(job: EnrichmentJob, memory: Memory): boolean;
  failJob(job: EnrichmentJob): void;
  close(): void;
}

/** The same sequential rules serve normal text and length-preserving chunk masking. */
function applyRedaction(text: string, preserveLength: boolean): string {
  const mask = (value: string) => value.replace(/[^\r\n]/g, '*');
  const replacement = (marker: string) => (value: string) =>
    preserveLength ? mask(value) : marker;
  const prepared = text
    .replace(
      /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)/g,
      replacement('[REDACTED PRIVATE KEY]'),
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement('[REDACTED AWS KEY]'))
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
      replacement('[REDACTED]'),
    )
    // Process the entire bearer value before generic Authorization assignment syntax.
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, replacement('[REDACTED BEARER]'))
    .replace(
      /\b(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s/@:]+:[^\s/@]+@/gi,
      replacement('[REDACTED CREDENTIAL URL]'),
    );
  return prepared.replace(
    /(["']?(?:api[_-]?key|(?:aws[_-]?)?secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|authorization|token|secret)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}&"'\r\n]+)/gi,
    (value: string, prefix: string, secret: string) => {
      if (preserveLength) return mask(value);
      const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : '';
      return `${prefix}${quote}[REDACTED]${quote}`;
    },
  );
}

/** Known-pattern defense, not a claim to detect every secret. */
export function redactText(text: string): string {
  return applyRedaction(text, false);
}

function redactOutputAcrossChunks(event: CapturedEvent): void {
  for (const stream of ['stdout', 'stderr'] as const) {
    const chunks = event.output
      .filter((chunk) => chunk.stream === stream)
      .sort((a, b) => a.ordinal - b.ordinal);
    const joined = applyRedaction(chunks.map((chunk) => chunk.text).join(''), true);
    let offset = 0;
    for (const chunk of chunks) {
      const length = chunk.text.length;
      chunk.text = joined.slice(offset, offset + length);
      offset += length;
    }
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
export function canonicalDigest(event: CapturedEvent): string {
  return createHash('sha256').update(canonical(event)).digest('hex');
}

export function prepareEvents(events: CapturedEvent[]): AcceptedEvent[] {
  if (events.length === 0 || events.length > captureLimits.batchEvents)
    throw new DomainError('BATCH_LIMIT', 'A batch must contain 1 to 50 finalized events.');
  if (Buffer.byteLength(JSON.stringify(events), 'utf8') > captureLimits.batchBytes)
    throw new DomainError('BATCH_LIMIT', 'Batch exceeds the 2 MiB limit.', 413);
  const accepted = new Map<string, AcceptedEvent>();
  for (const input of events) {
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > captureLimits.eventBytes)
      throw new DomainError('EVENT_LIMIT', 'Event exceeds the 512 KiB limit.', 413);
    const start = Date.parse(input.startedAt);
    const end = Date.parse(input.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new DomainError('INVALID_EVENT_TIME', 'Finalized event timestamps are invalid.');
    if (input.outcome.kind === 'completed' && input.outcome.exitCode === null)
      throw new DomainError(
        'INVALID_OUTCOME',
        'A completed command requires its observed exit code.',
      );
    if (input.outcome.kind === 'spawn_failed' && input.outcome.exitCode !== null)
      throw new DomainError('INVALID_OUTCOME', 'A spawn failure cannot have a process exit code.');
    const ordinals = new Set(input.output.map((chunk) => chunk.ordinal));
    if (ordinals.size !== input.output.length)
      throw new DomainError('INVALID_OUTPUT_ORDER', 'Output chunk ordinals must be unique.');
    if (
      input.output.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk.text, 'utf8'), 0) >
      captureLimits.outputBytes
    )
      throw new DomainError('OUTPUT_LIMIT', 'Output exceeds the 256 KiB per-event limit.', 413);
    if (new Set(input.diffs.map((diff) => diff.phase)).size !== input.diffs.length)
      throw new DomainError('INVALID_DIFFS', 'Only one diff per phase is allowed.');
    const digest = canonicalDigest(input);
    const prior = accepted.get(input.eventId);
    if (prior && prior.digest !== digest)
      throw new DomainError(
        'IMMUTABLE_EVENT_CONFLICT',
        'An event ID was reused with different evidence.',
        409,
      );
    const event = redactValue(input) as CapturedEvent;
    // Use original chunk lengths for cross-boundary masking before per-string redaction.
    event.output = input.output.map((chunk) => ({ ...chunk }));
    redactOutputAcrossChunks(event);
    event.output = event.output.map((chunk) => ({ ...chunk, text: redactText(chunk.text) }));
    for (let index = 1; index < event.command.args.length; index += 1) {
      if (
        /^--?(?:password|passwd|token|api[-_]?key|secret|client[-_]?secret)$/i.test(
          event.command.args[index - 1] ?? '',
        )
      )
        event.command.args[index] = '[REDACTED]';
    }
    event.capture.redacted = true;
    accepted.set(input.eventId, { event, digest });
  }
  return [...accepted.values()];
}

export function deriveObservedMemory(event: CapturedEvent): Memory {
  const command = [event.command.executable, ...event.command.args].join(' ').slice(0, 500);
  const result =
    event.outcome.kind === 'completed'
      ? `The process exited with code ${event.outcome.exitCode}.`
      : `The recorded outcome was ${event.outcome.kind.replaceAll('_', ' ')}${event.outcome.signal ? ` (${event.outcome.signal})` : ''}.`;
  const sources = [
    {
      id: event.eventId,
      kind: 'event' as const,
      repositoryId: event.repositoryId,
      locator: `/v1/events/${event.eventId}`,
    },
  ];
  const output = [...event.output]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((chunk) => `[${chunk.stream}] ${chunk.text}`)
    .join('\n')
    .slice(0, 1800);
  const steps = [
    {
      text: `Ran ${command} in ${event.cwd || 'the recorded working directory'}.`,
      sourceIds: [event.eventId],
    },
    { text: result, sourceIds: [event.eventId] },
  ];
  if (output.trim())
    steps.push({ text: `Recorded output:\n${output}`, sourceIds: [event.eventId] });
  if (event.diffs.length)
    steps.push({
      text: 'A bounded Git diff snapshot is attached to the source event; this alone does not establish which change caused the outcome.',
      sourceIds: [event.eventId],
    });
  const uncertainty = [
    'This summary reports observations, not inferred engineering intent or a proven root cause.',
    'A zero exit code or successful check alone does not prove the original issue was resolved.',
  ];
  if (!event.capture.complete || event.capture.truncatedBytes > 0)
    uncertainty.push('Captured output is incomplete or truncated; inspect capture metadata.');
  if (event.git.error) uncertainty.push('Some Git state could not be read during capture.');
  return {
    id: event.eventId,
    repositoryId: event.repositoryId,
    sessionId: event.sessionId,
    title: command.slice(0, 160),
    summary: `${command}\n${result}${output ? `\n${output}` : ''}`,
    mode: 'observed',
    label: observedLabel,
    outcome:
      event.outcome.kind === 'completed' ? `exit ${event.outcome.exitCode}` : event.outcome.kind,
    createdAt: event.endedAt,
    steps,
    sources,
    uncertainty,
  };
}

export type EvidenceEnricher = (event: CapturedEvent) => Promise<Memory>;
export async function runEnrichmentOnce(
  store: LocalEvidenceStore,
  enricher?: EvidenceEnricher,
): Promise<boolean> {
  const job = store.claimJob();
  if (!job) return false;
  try {
    store.completeJob(
      job,
      enricher ? await enricher(structuredClone(job.event)) : deriveObservedMemory(job.event),
    );
  } catch {
    store.failJob(job);
  }
  return true;
}

/** Token validation occurs in the API; this service owns a server-derived local context. */
export class LocalMemvora {
  constructor(public readonly store: LocalEvidenceStore) {}
  context(): LocalContext {
    return this.store.context();
  }
  createRepository(input: CreateRepository): Repository {
    return this.store.createRepository(this.context(), input);
  }
  getRepository(id: string): Repository {
    return this.store.getRepository(this.context(), id);
  }
  saveRepositoryContext(id: string, value: RepositoryContext): void {
    this.store.saveRepositoryContext(this.context(), id, value);
  }
  getRepositoryContext(id: string): RepositoryContext | null {
    return this.store.getRepositoryContext(this.context(), id);
  }
  ingest(events: CapturedEvent[]): string[] {
    return this.store.ingest(this.context(), prepareEvents(events));
  }
  ask(input: AskRequest, requestId: string): RecallAnswer {
    const context = this.context();
    if (input.sessionId) this.store.getSession(context, input.sessionId);
    const matches = this.store.search(context, input, input.sessionId);
    const expanded: Memory[] = [];
    let rawNeighbors = false;
    const memoryForEvent = (event: CapturedEvent): Memory => {
      try {
        return this.store.getMemory(context, event.eventId);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error;
        rawNeighbors = true;
        return deriveObservedMemory(event);
      }
    };
    // Query around the actual source sequence, including matches outside the latest timeline page.
    const groups = new Map<string, Map<string, CapturedEvent>>();
    for (const match of matches.slice(0, 10)) {
      if (!groups.has(match.sessionId) && groups.size >= 3) continue;
      const group = groups.get(match.sessionId) ?? new Map<string, CapturedEvent>();
      for (const event of this.store.neighborEvents(context, match.id, 3))
        group.set(event.eventId, event);
      groups.set(match.sessionId, group);
    }
    for (const group of groups.values()) {
      for (const event of [...group.values()].sort((a, b) => a.sequence - b.sequence)) {
        if (expanded.length >= 10) break;
        expanded.push(memoryForEvent(event));
      }
    }
    for (const match of matches) {
      if (expanded.length >= 10) break;
      if (!expanded.some((item) => item.id === match.id)) expanded.push(match);
    }
    const recentPhrases = new Set([
      'what failed in my last investigation',
      'which commands passed after the earlier failure',
      'where did i stop, and what is still unresolved',
      'resume last investigation',
      'resume my last investigation',
    ]);
    const normalizedQuery = input.query
      .trim()
      .toLowerCase()
      .replace(/[?!.]+$/, '')
      .replace(/\s+/g, ' ');
    let recentContext = false;
    if (!matches.length && recentPhrases.has(normalizedQuery)) {
      const session = input.sessionId
        ? this.store.getSession(context, input.sessionId)
        : this.store.recentSession(context, input.repositoryIds);
      if (
        session &&
        (!input.repositoryIds || input.repositoryIds.includes(session.session.repositoryId))
      ) {
        for (const event of session.events.slice(-10)) expanded.push(memoryForEvent(event));
        recentContext = expanded.length > 0;
      }
    }
    const items = expanded;
    const modes = new Set(items.map((item) => item.mode));
    const mode =
      modes.size > 1
        ? ('mixed' as const)
        : modes.has('ai')
          ? ('ai' as const)
          : ('observed' as const);
    return {
      status: items.length ? 'answered' : 'insufficient_evidence',
      mode,
      label: `${recentContext ? 'Recent investigation context — ' : ''}${
        mode === 'observed'
          ? observedLabel
          : mode === 'ai'
            ? 'Retrieved AI summaries with recorded source citations'
            : 'Retrieved observations and AI summaries with recorded source citations'
      }`,
      answer: items.length
        ? recentContext
          ? `Recovered ${items.length} recent recorded ${items.length === 1 ? 'step' : 'steps'} from the latest available investigation in your selected scope. Process outcomes are observations; they do not establish a confirmed fix or identify all unresolved work.`
          : `Found ${matches.length} matching recorded ${matches.length === 1 ? 'step' : 'steps'} and included nearby attempts from the same investigations, in recorded sequence order. These records do not establish a root cause or confirmed fix.`
        : 'There is insufficient stored evidence matching this query in the selected repositories. Capture and sync an investigation first, or try the exact error or command text.',
      steps: items.flatMap((item) => item.steps).slice(0, 30),
      sources: [
        ...new Map(
          items.flatMap((item) => item.sources).map((source) => [source.id, source]),
        ).values(),
      ],
      uncertainty: items.length
        ? [
            ...new Set([
              ...items.flatMap((item) => item.uncertainty),
              ...(rawNeighbors
                ? ['Some steps use direct observed evidence while enrichment is pending.']
                : []),
            ]),
          ]
        : ['No matching authorized evidence was found.'],
      requestId,
    };
  }
}

export function newId(): string {
  return randomUUID();
}
