import type { CapturedEvent, SessionRecap } from '@memvora/contracts';
import { DomainError, redactText } from './local-service.js';
import type { SessionRecapEvidence } from './local-service.js';

function excerpt(value: string, limit: number): string {
  // Evidence may contain terminal escape/control characters. Keep printable text and line breaks.
  let printable = '';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if ((point >= 32 && (point < 127 || point > 159)) || character === '\n' || character === '\t')
      printable += character;
  }
  // Normalize before redaction: removed controls can join fragments into a credential assignment.
  const safe = redactText(printable);
  if (safe.length <= limit) return safe;
  let shortened = safe.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/u.test(shortened)) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

function outcome(event: CapturedEvent): string {
  switch (event.outcome.kind) {
    case 'completed':
      return event.outcome.exitCode === null
        ? 'Completed; exit code was not recorded'
        : `Exited with code ${event.outcome.exitCode}`;
    case 'spawn_failed':
      return 'Command failed to start';
    case 'interrupted':
      return `Interrupted${event.outcome.signal ? ` (${excerpt(event.outcome.signal, 100)})` : ''}`;
    case 'incomplete':
      return 'Run ended without a complete outcome';
  }
}

function diffSummary(event: CapturedEvent): string {
  if (!event.diffs.length)
    return event.git.error
      ? 'Git probing failed; no diff snapshots were captured.'
      : 'No diff snapshots were captured.';
  const before = event.diffs.find((diff) => diff.phase === 'before');
  const after = event.diffs.find((diff) => diff.phase === 'after');
  const truncated = event.diffs.some((diff) => diff.truncatedBytes > 0);
  const parts = event.diffs.map(
    (diff) =>
      `${diff.phase === 'before' ? 'Before' : 'After'} HEAD-relative snapshot: ${diff.text ? 'nonempty' : 'empty'}`,
  );
  if (before && after && !event.git.error && !truncated)
    parts.push(
      before.text === after.text
        ? 'Snapshot texts match'
        : 'Snapshot texts differ; inspect the event for details',
    );
  if (event.git.error) parts.push('Git probing failed; snapshot comparison unavailable');
  if (truncated) parts.push('Snapshot text was truncated; full comparison unavailable');
  return `${parts.join('. ')}.`;
}

/** Reconstruct observations only. Counts and steps always refer to the disclosed event selection. */
export function deriveSessionRecap(evidence: SessionRecapEvidence): SessionRecap {
  const { session, events, totalEventCount } = evidence;
  const ids = new Set(events.map((event) => event.eventId));
  if (
    !Number.isSafeInteger(totalEventCount) ||
    totalEventCount < events.length ||
    events.length !== Math.min(totalEventCount, 40) ||
    ids.size !== events.length ||
    events.some(
      (event, index) =>
        event.sessionId !== session.id ||
        event.repositoryId !== session.repositoryId ||
        (index > 0 && event.sequence <= events[index - 1]!.sequence),
    )
  )
    throw new DomainError(
      'INVALID_RECAP_EVIDENCE',
      'The investigation evidence is inconsistent.',
      500,
    );

  const counts: SessionRecap['counts'] = {
    passed: 0,
    failed: 0,
    interrupted: 0,
    spawnFailed: 0,
    incomplete: 0,
    withDiffs: 0,
    incompleteCapture: 0,
  };
  const steps = events.map((event) => {
    if (event.outcome.kind === 'completed') {
      if (event.outcome.exitCode === 0) counts.passed++;
      else if (event.outcome.exitCode !== null) counts.failed++;
      else counts.incomplete++;
    } else if (event.outcome.kind === 'spawn_failed') counts.spawnFailed++;
    else if (event.outcome.kind === 'interrupted') counts.interrupted++;
    else counts.incomplete++;
    if (event.diffs.some((diff) => diff.text.length > 0)) counts.withDiffs++;
    if (!event.capture.complete || event.capture.truncatedBytes > 0) counts.incompleteCapture++;
    let output = '';
    let stream: 'stdout' | 'stderr' | undefined;
    for (const chunk of [...event.output].sort((left, right) => left.ordinal - right.ordinal)) {
      if (chunk.stream !== stream) {
        if (output && !output.endsWith('\n')) output += '\n';
        output += `[${chunk.stream}] `;
        stream = chunk.stream;
      }
      output += chunk.text;
    }
    return {
      sequence: event.sequence,
      eventId: event.eventId,
      command: excerpt([event.command.executable, ...event.command.args].join(' '), 300),
      outcome: outcome(event),
      outputExcerpt: excerpt(output, 600),
      diffSummary: diffSummary(event),
    };
  });
  const omittedEvents = totalEventCount - events.length;
  const uncertainty = [
    'Commands and outcomes are observations. Engineer intent, root cause and a causal fix are not established by this recap.',
    'A zero exit code records a successful command exit; it does not by itself prove that the underlying issue is resolved.',
    'Commands and output are shortened excerpts. Git snapshots are relative to HEAD and may include pre-existing changes; they do not isolate changes made by a command. Open each event for the original stored evidence.',
  ];
  if (omittedEvents)
    uncertainty.push(
      `${omittedEvents} middle attempts are omitted: only the first 20 and last 20 accepted events in session-sequence order are included. Counts describe those 40 events, not the whole investigation. Open the paged timeline for the rest.`,
    );
  if (counts.incompleteCapture)
    uncertainty.push(
      `${counts.incompleteCapture} included attempts have incomplete or truncated evidence capture.`,
    );
  if (
    events.some((event) => event.git.error || event.diffs.some((diff) => diff.truncatedBytes > 0))
  )
    uncertainty.push('Some included Git metadata or diff snapshots are unavailable or truncated.');
  if (session.status === 'open')
    uncertainty.push(
      'This investigation is still open. Refresh the recap to include later accepted uploads.',
    );

  const summary = events.length
    ? `${events.length} of ${totalEventCount} recorded attempts are included: ${counts.passed} exited with code 0, ${counts.failed} with a nonzero code, ${counts.spawnFailed} failed to start, ${counts.interrupted} were interrupted and ${counts.incomplete} have no complete exit outcome. ${counts.withDiffs} include nonempty diff snapshots. The latest included attempt (#${events.at(-1)!.sequence}) ${outcome(events.at(-1)!).toLowerCase()}.`
    : 'No accepted commands have been recorded in this investigation yet. There is no evidence to reconstruct an outcome.';
  return {
    session: { ...session, title: excerpt(session.title, 200) },
    generatedAt: new Date().toISOString(),
    mode: 'observed',
    label: 'Observed investigation recap — deterministic, not AI-generated',
    summary,
    coverage: {
      totalEvents: totalEventCount,
      includedEvents: events.length,
      omittedEvents,
      eventLimit: 40,
      selection: omittedEvents ? 'first_and_last' : 'all',
    },
    counts,
    steps,
    sources: events.map((event) => ({
      id: event.eventId,
      kind: 'event',
      repositoryId: event.repositoryId,
      locator: `/v1/events/${event.eventId}`,
    })),
    uncertainty,
  };
}
