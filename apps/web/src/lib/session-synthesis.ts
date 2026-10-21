import { Compile } from 'typebox/compile';
import {
  CreateSessionSynthesisSchema,
  IdSchema,
  type CreateSessionSynthesis,
  type SessionSynthesisPreview,
} from '@memvora/contracts';

export function synthesisRequestQuery(
  parameters: Record<string, string | string[] | undefined>,
): { requestId?: string } | null {
  if (Object.keys(parameters).some((key) => key !== 'requestId')) return null;
  const id = parameters.requestId;
  if (id === undefined) return {};
  return typeof id === 'string' && Compile(IdSchema).Check(id) ? { requestId: id } : null;
}

export function synthesisUrlQuery(url: string): { requestId?: string } | null {
  const parameters: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(url).searchParams) {
    if (key in parameters) return null;
    parameters[key] = value;
  }
  return synthesisRequestQuery(parameters);
}

/** An uncertain response must keep the reviewed hash and the original request identity. */
export function retainedSynthesisAttempt(
  preview: SessionSynthesisPreview,
  previous: CreateSessionSynthesis | null,
  generateId: () => string,
): CreateSessionSynthesis {
  if (previous) {
    if (!Compile(CreateSessionSynthesisSchema).Check(previous))
      throw new Error('The retained request is invalid.');
    return previous;
  }
  if (preview.availability !== 'available' || !preview.configuration || !preview.inputHash)
    throw new Error('Review an available synthesis preview before requesting interpretation.');
  const input = { requestId: generateId(), expectedInputHash: preview.inputHash };
  if (!Compile(CreateSessionSynthesisSchema).Check(input))
    throw new Error('The reviewed input or request identity is invalid.');
  return input;
}
