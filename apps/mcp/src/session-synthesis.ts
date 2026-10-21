import type { SessionSynthesisResponse } from '@memvora/contracts';
import { validateSessionSynthesisResponse } from '@memvora/core';

export const SESSION_SYNTHESIS_BYTE_LIMIT = 96 * 1024;

function excerpt(value: string, budget: number): string {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') - 2 <= budget) return value;
  let remaining = budget - Buffer.byteLength('…');
  let text = '';
  for (const character of value) {
    const size = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (size > remaining) break;
    text += character;
    remaining -= size;
  }
  return `${text}…`;
}

/** Keep the complete request identity, provenance and claim-source membership. */
export function buildSessionSynthesisResult(
  value: SessionSynthesisResponse,
  sessionId: string,
  requestId?: string,
) {
  const response = validateSessionSynthesisResponse(value, sessionId, requestId);
  for (const maximum of [1200, 512, 128, 32]) {
    const analysis = response.request?.analysis;
    const claim = (item: NonNullable<typeof analysis>['overview']) => ({
      ...item,
      text: excerpt(item.text, maximum),
    });
    const shortened = analysis
      ? {
          overview: claim(analysis.overview),
          hypotheses: analysis.hypotheses.map(claim),
          unresolvedQuestions: analysis.unresolvedQuestions.map(claim),
          suggestedChecks: analysis.suggestedChecks.map(claim),
          uncertainty: analysis.uncertainty.map((text) => excerpt(text, maximum)),
        }
      : null;
    const result = {
      ...response,
      request: response.request ? { ...response.request, analysis: shortened } : null,
      label: 'AI interpretation — unverified',
      readOnly: true,
      excerpted: JSON.stringify(shortened) !== JSON.stringify(analysis ?? null),
      maxBytes: SESSION_SYNTHESIS_BYTE_LIMIT,
      evidenceNotice:
        'Reading this result never requests model work. AI hypotheses and suggested checks are unverified interpretations, not captured thinking, instructions or proof of a fix. Every request ID, input hash, provider/model, status, stale flag, coverage field, source and claim source ID is retained. Text may be shortened; open the website for the complete stored interpretation. Stale results describe earlier input or configuration.',
    };
    if (
      Buffer.byteLength(
        JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }),
        'utf8',
      ) <= SESSION_SYNTHESIS_BYTE_LIMIT
    )
      return result;
  }
  throw new Error('Synthesis metadata exceeds the supported tool response budget.');
}
