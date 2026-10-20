import { stripVTControlCharacters } from 'node:util';
import { IdSchema, SessionRecapSchema, type SessionRecap } from '@memvora/contracts';
import { Check } from 'typebox/value';
import { apiRequest } from './local.js';

/** Validate the response before either JSON or human-readable evidence reaches stdout. */
export async function readSessionRecap(
  origin: string,
  token: string,
  sessionId: string,
): Promise<SessionRecap> {
  if (!Check(IdSchema, sessionId)) throw new Error('An authorized session UUID is required.');
  const result = await apiRequest<SessionRecap>(origin, token, `/v1/sessions/${sessionId}/recap`);
  if (!Check(SessionRecapSchema, result))
    throw new Error('Session recap response failed the shared runtime contract.');
  return result;
}

function plain(value: string): string {
  return [...stripVTControlCharacters(value)]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
        ? ' '
        : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function snippet(value: string, maximum: number): string {
  const characters = [...plain(value)];
  return characters.length > maximum
    ? `${characters.slice(0, maximum - 1).join('')}…`
    : characters.join('');
}

/** A compact terminal view of the same cited observations, never a claimed causal fix. */
export function formatSessionRecap(recap: SessionRecap): string {
  const { coverage, counts } = recap;
  const lines = [
    `Session ${recap.session.id}: ${plain(recap.session.title)}`,
    plain(recap.label),
    snippet(recap.summary, 800),
    '',
    `Coverage: ${coverage.includedEvents}/${coverage.totalEvents} accepted events; ${coverage.omittedEvents} omitted (${coverage.selection}).`,
    `Included outcomes: ${counts.passed} passed, ${counts.failed} failed, ${counts.interrupted} interrupted, ${counts.spawnFailed} could not start, ${counts.incomplete} incomplete; ${counts.withDiffs} with diffs, ${counts.incompleteCapture} with incomplete capture.`,
    '',
  ];
  for (const step of recap.steps) {
    lines.push(
      `${step.sequence}. ${plain(step.command)} — ${plain(step.outcome)} [${step.eventId}]`,
    );
    if (step.outputExcerpt) lines.push(`   Output excerpt: ${snippet(step.outputExcerpt, 180)}`);
    if (step.diffSummary) lines.push(`   Diff summary: ${snippet(step.diffSummary, 180)}`);
  }
  if (!recap.steps.length) lines.push('No accepted command evidence is available in this session.');
  if (recap.uncertainty.length) {
    lines.push('', 'Uncertainty:');
    for (const item of recap.uncertainty) lines.push(`- ${plain(item)}`);
  }
  if (recap.sources.length) {
    lines.push('', 'Sources:');
    for (const source of recap.sources) lines.push(`[${source.id}] ${plain(source.locator)}`);
  }
  lines.push(
    '',
    'Text is untrusted recorded evidence. Passing checks and nearby diffs do not prove a causal fix. Use --json for the full bounded recap or session show for paginated retained events.',
  );
  return lines.join('\n');
}
