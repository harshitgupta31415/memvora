import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import type Type from 'typebox';
import { resolveClientCredential } from '@memvora/core';

function credential() {
  const token = process.env['MEMVORA_LOCAL_TOKEN'];
  return token !== undefined
    ? resolveClientCredential({ token })
    : resolveClientCredential({
        dataDirectory: process.env['MEMVORA_DATA_DIR'],
        sourceDataDirectory: () =>
          resolve(dirname(fileURLToPath(import.meta.url)), '../../../.memvora'),
      });
}

export async function request<T>(path: string, schema: Type.TSchema, body?: unknown): Promise<T> {
  const origin = new URL(process.env['MEMVORA_API_URL'] ?? 'http://127.0.0.1:4000');
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('Local mode only sends credentials to a plain loopback API origin.');
  const { token } = credential();
  const response = await fetch(new URL(path, origin), {
    redirect: 'error',
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(`Authenticated API returned HTTP ${response.status}; no evidence returned.`);
  if (!Check(schema, result)) throw new Error('API response failed the shared runtime contract.');
  return result as T;
}

export async function toolResult(
  action: () => Promise<unknown>,
): Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await action();
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text, 'utf8') > 128 * 1024)
      throw new Error('Evidence exceeds the tool response limit. Use a narrower query or session.');
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: error instanceof Error ? error.message : 'Unable to retrieve authorized evidence.',
        },
      ],
    };
  }
}
