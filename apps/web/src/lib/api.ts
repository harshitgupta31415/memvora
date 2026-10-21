import 'server-only';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { headers } from 'next/headers';
import { Compile } from 'typebox/compile';
import type { Static, TSchema } from 'typebox';

export type ApiResult<T> =
  { ok: true; data: T; status: number } | { ok: false; message: string; status: number };
const projectRoot = resolve(process.cwd(), '../..');
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);

export function trustedLocalHost(host: string | null): boolean {
  if (!host || /[\s/@?#\\]/u.test(host)) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return loopbackNames.has(parsed.hostname) && parsed.host === host.toLowerCase();
  } catch {
    return false;
  }
}

export function trustedMutation(request: Request): boolean {
  const host = request.headers.get('host');
  if (!trustedLocalHost(host)) return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.host === host?.toLowerCase() &&
      parsed.origin === origin
    );
  } catch {
    return false;
  }
}

async function localCredential(): Promise<string | null> {
  if (process.env.MEMVORA_LOCAL_TOKEN?.trim()) return process.env.MEMVORA_LOCAL_TOKEN.trim();
  const directory = process.env.MEMVORA_DATA_DIR ?? resolve(projectRoot, '.memvora');
  if (!isAbsolute(directory)) return null;
  try {
    // Runtime-only credential: it must never be copied into a web build artifact.
    return (
      (
        await readFile(resolve(/* turbopackIgnore: true */ directory, 'local-token'), 'utf8')
      ).trim() || null
    );
  } catch {
    return null;
  }
}

export async function apiRequest<S extends TSchema>(
  path: string,
  schema: S,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number } = {},
): Promise<ApiResult<Static<S>>> {
  const incoming = await headers();
  if (!trustedLocalHost(incoming.get('host')))
    return {
      ok: false,
      message: 'This local workspace is available only through a loopback address.',
      status: 403,
    };
  const credential = await localCredential();
  if (!credential)
    return {
      ok: false,
      message: 'The local workspace credential is missing. Complete local setup, then refresh.',
      status: 401,
    };
  try {
    const origin = new URL(process.env.MEMVORA_API_URL ?? 'http://127.0.0.1:4000');
    if (
      !loopbackNames.has(origin.hostname) ||
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password
    )
      return { ok: false, message: 'Local mode requires a loopback API URL.', status: 503 };
    const response = await fetch(new URL(path, origin), {
      method: options.method ?? 'GET',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      let message =
        response.status === 401
          ? 'The local credential was rejected. Check your workspace setup.'
          : response.status === 403
            ? 'Access to this workspace resource was denied.'
            : response.status === 404
              ? 'This record was not found in the local workspace.'
              : 'The API could not complete this request.';
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
      return { ok: false, message, status: response.status };
    }
    if (!Compile(schema).Check(value))
      return {
        ok: false,
        message: 'The API response did not match the expected contract.',
        status: 502,
      };
    return { ok: true, data: value as Static<S>, status: response.status };
  } catch {
    return {
      ok: false,
      message: 'The local API is unavailable. Start the API and try again.',
      status: 503,
    };
  }
}

export function resultResponse<T>(result: ApiResult<T>): Response {
  return result.ok
    ? Response.json(result.data)
    : Response.json({ error: { message: result.message } }, { status: result.status });
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new Error('Send a JSON request.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('A request body is required.');
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 32_768) {
      await reader.cancel();
      throw new Error('The request is too large.');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}
