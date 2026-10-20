import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveDataDir(): string {
  const configured = process.env['MEMVORA_DATA_DIR'];
  if (configured && !isAbsolute(configured))
    throw new Error('MEMVORA_DATA_DIR must be an absolute path.');
  return configured ?? resolve(fileURLToPath(new URL('../../../', import.meta.url)), '.memvora');
}
function validateToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || /\s/.test(token))
    throw new Error('MEMVORA_LOCAL_TOKEN must have at least 32 non-whitespace characters.');
  return token;
}
/** Explicit bootstrap only; importing this module never reads or creates credentials. */
export function loadLocalToken(options: { create?: boolean; dataDir?: string } = {}): string {
  if (process.env['MEMVORA_LOCAL_TOKEN']) return validateToken(process.env['MEMVORA_LOCAL_TOKEN']);
  const directory = options.dataDir ?? resolveDataDir();
  const path = resolve(directory, 'local-token');
  try {
    return validateToken(readFileSync(path, 'utf8'));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT' ||
      !options.create
    )
      throw new Error(
        'Local credential unavailable. Start the API once, or set MEMVORA_LOCAL_TOKEN.',
      );
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  return validateToken(readFileSync(path, 'utf8'));
}
