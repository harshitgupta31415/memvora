import { closeSync, openSync, writeFileSync } from 'node:fs';
import {
  IdSchema,
  SessionHandoverDownloadSchema,
  SessionHandoverSchema,
  type SessionHandoverDownload,
} from '@memvora/contracts';
import { Check } from 'typebox/value';
import { apiRequest } from './local.js';

export const HANDOVER_DOWNLOAD_BYTE_LIMIT = 8 * 1024 * 1024;
export type HandoverFormat = 'json' | 'markdown';

export function handoverFormat(value = 'markdown'): HandoverFormat {
  if (value !== 'json' && value !== 'markdown')
    throw new Error('Use --format json or --format markdown.');
  return value;
}

/** Validate all download metadata and bytes before creating a file or writing stdout. */
export async function readSessionHandoverDownload(
  origin: string,
  token: string,
  sessionId: string,
  format: HandoverFormat,
): Promise<SessionHandoverDownload> {
  if (!Check(IdSchema, sessionId)) throw new Error('An authorized session UUID is required.');
  handoverFormat(format);
  const response = await apiRequest<SessionHandoverDownload>(
    origin,
    token,
    `/v1/sessions/${sessionId}/handover/download?format=${format}`,
  );
  const extension = format === 'json' ? 'json' : 'md';
  if (
    !Check(SessionHandoverDownloadSchema, response) ||
    response.format !== format ||
    response.filename !== `memvora-handover-${sessionId}.${extension}` ||
    response.mediaType !== (format === 'json' ? 'application/json' : 'text/markdown') ||
    Buffer.byteLength(response.content, 'utf8') > HANDOVER_DOWNLOAD_BYTE_LIMIT
  )
    throw new Error('Handover download failed its format, filename or byte contract.');
  if (format === 'json') {
    let report: unknown;
    try {
      report = JSON.parse(response.content);
    } catch {
      throw new Error('Handover JSON is invalid.');
    }
    if (!Check(SessionHandoverSchema, report) || report.session.id !== sessionId)
      throw new Error('Handover JSON failed the shared report contract.');
  }
  return response;
}

/** Exclusive creation rejects existing regular files and symlinks without a check/write race. */
export function writeSessionHandoverFile(path: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > HANDOVER_DOWNLOAD_BYTE_LIMIT)
    throw new Error('Handover content exceeds the download byte limit.');
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        'Output already exists. Choose a new path; files and symlinks are never overwritten.',
      );
    throw new Error(
      'The new export file could not be created. Check its parent directory and permissions.',
    );
  }
  try {
    writeFileSync(descriptor, content, 'utf8');
  } catch {
    // Never unlink by pathname after a failed write: another process could have replaced it.
    throw new Error(
      'Export write failed. A newly created partial file may remain; it was not removed.',
    );
  } finally {
    closeSync(descriptor);
  }
}
