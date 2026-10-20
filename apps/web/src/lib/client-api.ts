'use client';

import { Compile } from 'typebox/compile';
import type { Static, TSchema } from 'typebox';

export async function getJson<S extends TSchema>(path: string, schema: S): Promise<Static<S>> {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  return readResponse(response, schema);
}

async function readResponse<S extends TSchema>(response: Response, schema: S): Promise<Static<S>> {
  const value: unknown = await response.json();
  if (!response.ok) {
    let message = 'The request could not be completed. Please try again.';
    if (
      typeof value === 'object' &&
      value !== null &&
      'error' in value &&
      typeof value.error === 'object' &&
      value.error !== null &&
      'message' in value.error &&
      typeof value.error.message === 'string'
    )
      message = value.error.message;
    throw new Error(message);
  }
  if (!Compile(schema).Check(value)) throw new Error('The server returned an unexpected response.');
  return value as Static<S>;
}

export async function submitJson<S extends TSchema>(
  path: string,
  input: unknown,
  schema: S,
  timeoutMs = 20_000,
): Promise<Static<S>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return readResponse(response, schema);
}
