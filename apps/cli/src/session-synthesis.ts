import { randomUUID } from 'node:crypto';
import {
  CreateSessionSynthesisSchema,
  IdSchema,
  type CreateSessionSynthesis,
  type SessionSynthesisPreview,
  type SessionSynthesisResponse,
  type SessionSynthesisHistory,
} from '@memvora/contracts';
import { Check } from 'typebox/value';
import {
  validateSessionSynthesisHistory,
  validateSessionSynthesisPreview,
  validateSessionSynthesisResponse,
} from '@memvora/core';
import { apiRequest } from './local.js';

export function prepareSynthesisRequest(
  inputHash: string,
  requestId?: string,
  generateId: () => string = randomUUID,
): CreateSessionSynthesis {
  const input = { requestId: requestId ?? generateId(), expectedInputHash: inputHash };
  if (!Check(CreateSessionSynthesisSchema, input))
    throw new Error(
      'Use the 64-character lowercase input hash from synthesis-preview and an optional UUID --request-id.',
    );
  return input;
}

export function synthesisRetryMessage(sessionId: string, input: CreateSessionSynthesis): string {
  return `Synthesis submission was not confirmed. Check session synthesis ${sessionId} --request-id ${input.requestId}, or retry session synthesize ${sessionId} --input-hash ${input.expectedInputHash} --request-id ${input.requestId}. Keep the same identity and hash; no automatic retry was performed.`;
}

function validSession(id: string): void {
  if (!Check(IdSchema, id)) throw new Error('An authorized session UUID is required.');
}

export async function readSynthesisHistory(
  origin: string,
  token: string,
  sessionId: string,
): Promise<SessionSynthesisHistory> {
  validSession(sessionId);
  return validateSessionSynthesisHistory(
    await apiRequest(origin, token, `/v1/sessions/${sessionId}/synthesis/history`),
    sessionId,
  );
}

export async function readSynthesisPreview(
  origin: string,
  token: string,
  sessionId: string,
): Promise<SessionSynthesisPreview> {
  validSession(sessionId);
  return validateSessionSynthesisPreview(
    await apiRequest(origin, token, `/v1/sessions/${sessionId}/synthesis/preview`),
    sessionId,
  );
}

export async function readSessionSynthesis(
  origin: string,
  token: string,
  sessionId: string,
  requestId?: string,
): Promise<SessionSynthesisResponse> {
  validSession(sessionId);
  if (requestId !== undefined && !Check(IdSchema, requestId))
    throw new Error('Use a UUID --request-id.');
  const query = requestId === undefined ? '' : `?${new URLSearchParams({ requestId })}`;
  return validateSessionSynthesisResponse(
    await apiRequest(origin, token, `/v1/sessions/${sessionId}/synthesis${query}`),
    sessionId,
    requestId,
  );
}

export async function submitSessionSynthesis(
  origin: string,
  token: string,
  sessionId: string,
  input: CreateSessionSynthesis,
): Promise<SessionSynthesisResponse> {
  validSession(sessionId);
  if (!Check(CreateSessionSynthesisSchema, input))
    throw new Error('A valid synthesis request UUID and input hash are required.');
  try {
    const value = validateSessionSynthesisResponse(
      await apiRequest(origin, token, `/v1/sessions/${sessionId}/synthesis`, input),
      sessionId,
      input.requestId,
    );
    if (!value.request || value.request.inputHash !== input.expectedInputHash)
      throw new Error('Unexpected synthesis input.');
    return value;
  } catch {
    // A timeout may follow a durable queue write. Never invent a new retry identity.
    throw new Error(synthesisRetryMessage(sessionId, input));
  }
}
