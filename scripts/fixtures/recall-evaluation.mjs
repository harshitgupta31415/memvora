// Versioned synthetic relevance judgments. Freeze these independently of retrieved rankings.
export const corpusVersion = 1;
export const fixtureId = (number) =>
  `71000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
export const ids = {
  old: fixtureId(4),
  redis: fixtureId(201),
  beta: fixtureId(301),
  pending: fixtureId(401),
  stored: fixtureId(402),
  argument: fixtureId(403),
  diff: fixtureId(404),
  late: fixtureId(405),
  anchorA: fixtureId(1004),
  anchorB: fixtureId(2004),
  anchorC: fixtureId(3004),
  distantA: fixtureId(4004),
  distantB: fixtureId(4011),
  journal: fixtureId(9001),
};
const preamble =
  'Please recover historical investigation evidence regarding intermittent production database connectivity during yesterday deployment after configuration rotation while multiple workers restarted under customer traffic using existing repository records explain previous diagnostic attempts and observed validation without guessing missing details for'.split(
    ' ',
  );
if (preamble.length !== 39)
  throw new Error('The frozen evaluation question must contain39 preamble words.');
function longQuestion(term, middle = false) {
  const words = [...preamble];
  words.splice(middle ? 20 : words.length, 0, term);
  return words.join(' ');
}
export const sessions = [
  { key: 'old', repository: 'alpha', length: 120, base: 0 },
  { key: 'redis', repository: 'alpha', length: 1, base: 200 },
  { key: 'beta', repository: 'beta', length: 1, base: 300 },
  { key: 'current', repository: 'alpha', length: 5, base: 400 },
  { key: 'anchorA', repository: 'alpha', length: 7, base: 1000 },
  { key: 'anchorB', repository: 'alpha', length: 7, base: 2000 },
  { key: 'anchorC', repository: 'alpha', length: 7, base: 3000 },
  { key: 'distant', repository: 'alpha', length: 14, base: 4000 },
];
export function eventsFor(session, repositoryId, sessionId) {
  return Array.from({ length: session.length }, (_unused, index) => {
    const sequence = index + 1;
    const eventId = fixtureId(session.base + sequence);
    let output = `Routine fixture observation ${sequence}.`;
    if (eventId === ids.old)
      output = 'PostgresPoolConnectFailure: ECONNREFUSED 127.0.0.1:5432 postgres.';
    if (eventId === ids.redis)
      output = 'RedisCacheConnectFailure: ECONNREFUSED 127.0.0.1:6379 redis.';
    if (eventId === ids.beta)
      output = 'BetaDatabaseConnectFailure: ECONNREFUSED 127.0.0.1:5432 postgres.';
    if (eventId === ids.pending) output = 'PendingLeaseFailure: original timeout observation.';
    if (eventId === ids.stored)
      output = 'DriverConnectOriginalTrace: retained raw socket observation.';
    if ([ids.anchorA, ids.anchorB, ids.anchorC].includes(eventId))
      output = 'SharedInvestigationTrace: distinct middle attempt in this session.';
    if ([ids.distantA, ids.distantB].includes(eventId))
      output = 'DistantAnchorTrace: distinct matching attempt.';
    if (eventId === ids.late)
      output = `${'unrelated compiler chatter\n'.repeat(1200)}LateLeaseExpiryTrace: final retained diagnostic.`;
    return {
      eventId,
      repositoryId,
      sessionId,
      sequence,
      startedAt: '2026-10-21T10:00:00.000Z',
      endedAt: '2026-10-21T10:00:01.000Z',
      command: {
        executable: 'synthetic-fixture',
        args: eventId === ids.argument ? ['--diagnose-pool'] : ['fixture.cjs'],
        shell: 'fixture_not_executed',
      },
      cwd: `synthetic-${session.repository}`,
      git: { commitSha: null, dirty: eventId === ids.diff },
      outcome: { kind: 'completed', exitCode: 1, signal: null },
      capture: { complete: true, truncatedBytes: 0, redacted: true },
      output: [{ stream: 'stderr', ordinal: 0, text: output }],
      diffs:
        eventId === ids.diff
          ? [{ phase: 'after', text: '+refreshPoolLease();', truncatedBytes: 0 }]
          : [],
    };
  });
}
export const journal = {
  id: ids.journal,
  kind: 'decision',
  body: 'LeaseHandoverDecision: retain the timeout; an author claim awaiting independent validation.',
  eventIds: [ids.stored],
};
export const sourceText = 'export function ReconnectLeasePolicy() { return 3; }\n';
export const cases = [
  {
    id: 'old-exact-error',
    category: 'old_history',
    query: 'PostgresPoolConnectFailure',
    relevant: ['old'],
    cli: true,
    mcp: true,
  },
  {
    id: 'similar-error-family',
    category: 'similar_errors',
    query: 'ECONNREFUSED',
    relevant: ['old', 'redis'],
    repositories: ['alpha'],
  },
  {
    id: 'other-repository-same-error',
    category: 'repository_scope',
    query: 'ECONNREFUSED',
    relevant: ['beta'],
    repositories: ['beta'],
    cli: true,
  },
  {
    id: 'command-argument',
    category: 'raw_fields',
    query: '--diagnose-pool',
    relevant: ['argument'],
  },
  { id: 'diff-identifier', category: 'raw_fields', query: 'refreshPoolLease', relevant: ['diff'] },
  {
    id: 'late-noisy-output',
    category: 'noisy_output',
    query: 'LateLeaseExpiryTrace',
    relevant: ['late'],
    mcp: true,
  },
  {
    id: 'summary-still-queued',
    category: 'processing_state',
    query: 'PendingLeaseFailure',
    relevant: ['pending'],
  },
  {
    id: 'raw-match-prefers-summary',
    category: 'processing_state',
    query: 'DriverConnectOriginalTrace',
    relevant: ['stored'],
  },
  {
    id: 'stored-summary-only-term',
    category: 'summary_terms',
    query: 'LeaseRehydrationSummary',
    relevant: ['stored'],
  },
  {
    id: 'empty-repository-selector',
    category: 'scope_empty',
    query: 'ECONNREFUSED',
    relevant: [],
    repositories: [],
    scopeEmpty: true,
  },
  {
    id: 'absent-evidence',
    category: 'no_evidence',
    query: 'AbsentConstellationMarkerNeverCaptured',
    relevant: [],
    cli: true,
  },
  {
    id: 'forty-terms-error-at-end',
    baselineAllowed: ['must_hit_relevant_ids_at5', 'ask_missing_citation', 'ask_missing_step'],
    category: 'long_query',
    query: longQuestion('PostgresPoolConnectFailure'),
    relevant: ['old'],
    cli: true,
    mcp: true,
  },
  {
    id: 'forty-terms-error-in-middle',
    baselineAllowed: ['must_hit_relevant_ids_at5', 'ask_missing_citation', 'ask_missing_step'],
    category: 'long_query',
    query: longQuestion('PostgresPoolConnectFailure', true),
    relevant: ['old'],
  },
  {
    id: 'three-session-middle-anchors',
    baselineAllowed: ['ask_missing_citation', 'ask_missing_step'],
    category: 'ask_coverage',
    query: 'SharedInvestigationTrace',
    relevant: ['anchorA', 'anchorB', 'anchorC'],
    askRequired: ['anchorA', 'anchorB', 'anchorC'],
    enforceBudget: true,
  },
  {
    id: 'one-session-distant-anchors',
    baselineAllowed: ['ask_missing_citation', 'ask_missing_step'],
    category: 'ask_coverage',
    query: 'DistantAnchorTrace',
    relevant: ['distantA', 'distantB'],
    askRequired: ['distantA', 'distantB'],
    session: 'distant',
    enforceBudget: true,
  },
  {
    id: 'journal-literal',
    category: 'journal',
    endpoint: 'notes',
    query: 'LeaseHandoverDecision',
    relevant: ['journal'],
  },
  {
    id: 'imported-code-literal',
    category: 'code',
    endpoint: 'code',
    query: 'ReconnectLeasePolicy',
    relevant: ['code'],
  },
  {
    id: 'forty-terms-journal-at-end',
    baselineAllowed: ['must_hit_relevant_ids_at5', 'ask_missing_citation', 'ask_missing_step'],
    category: 'long_query_journal',
    endpoint: 'notes',
    query: longQuestion('LeaseHandoverDecision'),
    relevant: ['journal'],
  },
  {
    id: 'forty-terms-code-at-end',
    baselineAllowed: ['must_hit_relevant_ids_at5', 'ask_missing_citation', 'ask_missing_step'],
    category: 'long_query_code',
    endpoint: 'code',
    query: longQuestion('ReconnectLeasePolicy'),
    relevant: ['code'],
  },
  {
    id: 'unsupported-paraphrase-boundary',
    category: 'lexical_boundary',
    query: 'reservation lifecycle rejuvenation',
    relevant: [],
    boundaryProbe: true,
  },
].map((entry) => ({
  repositories: ['alpha'],
  endpoint: 'memories',
  baselineAllowed: [],
  ...entry,
}));
