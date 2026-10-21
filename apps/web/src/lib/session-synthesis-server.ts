import 'server-only';
import {
  SessionSynthesisPreviewSchema,
  SessionSynthesisResponseSchema,
  type CreateSessionSynthesis,
  type SessionSynthesisPreview,
  type SessionSynthesisResponse,
} from '@memvora/contracts';
import {
  validateSessionSynthesisPreview,
  validateSessionSynthesisResponse,
} from '@memvora/core/session-synthesis';
import { apiRequest, type ApiResult } from './api';

export async function synthesisPreview(
  sessionId: string,
): Promise<ApiResult<SessionSynthesisPreview>> {
  const result = await apiRequest(
    `/v1/sessions/${encodeURIComponent(sessionId)}/synthesis/preview`,
    SessionSynthesisPreviewSchema,
  );
  if (!result.ok) return result;
  try {
    return { ...result, data: validateSessionSynthesisPreview(result.data, sessionId) };
  } catch {
    return {
      ok: false,
      status: 502,
      message: 'The synthesis preview did not match the selected investigation.',
    };
  }
}

export async function synthesisStatus(
  sessionId: string,
  requestId?: string,
  input?: CreateSessionSynthesis,
): Promise<ApiResult<SessionSynthesisResponse>> {
  const query = requestId === undefined ? '' : `?${new URLSearchParams({ requestId })}`;
  const result = await apiRequest(
    `/v1/sessions/${encodeURIComponent(sessionId)}/synthesis${input ? '' : query}`,
    SessionSynthesisResponseSchema,
    input ? { method: 'POST', body: input } : {},
  );
  if (!result.ok) return result;
  try {
    const data = validateSessionSynthesisResponse(
      result.data,
      sessionId,
      input?.requestId ?? requestId,
    );
    if (input && (!data.request || data.request.inputHash !== input.expectedInputHash))
      throw new Error('Unexpected input.');
    return { ...result, data };
  } catch {
    return {
      ok: false,
      status: 502,
      message: 'The synthesis response did not match the selected investigation and request.',
    };
  }
}
