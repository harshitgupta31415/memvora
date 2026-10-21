import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

declare const __MEMVORA_PORTABLE_CLIENT__: boolean;

export const CLIENT_VERSION = '0.4.0';
export const IS_PORTABLE_CLIENT =
  typeof __MEMVORA_PORTABLE_CLIENT__ !== 'undefined' && __MEMVORA_PORTABLE_CLIENT__ === true;

export interface ClientRuntimeOptions {
  portable?: boolean | undefined;
  home?: string | undefined;
  dataDirectory?: string | undefined;
  sourceDataDirectory?: (() => string) | undefined;
}

export type ClientCredential =
  | { token: string; source: 'environment' }
  | { token: string; source: 'file'; credentialPath: string };

const configurationInstruction =
  'Configure an absolute server data directory with CLI --home or MEMVORA_DATA_DIR, or supply MEMVORA_LOCAL_TOKEN. Start the local API first if needed.';

export function resolveClientDataDirectory(options: ClientRuntimeOptions = {}): string {
  const portable = options.portable ?? IS_PORTABLE_CLIENT;
  const selected = options.home ?? options.dataDirectory;
  if (selected !== undefined) {
    if (
      !selected.trim() ||
      /[\u0000-\u001f\u007f]/u.test(selected) ||
      (portable && !isAbsolute(selected))
    )
      throw new Error(configurationInstruction);
    return resolve(selected);
  }
  if (portable || !options.sourceDataDirectory) throw new Error(configurationInstruction);
  try {
    const source = options.sourceDataDirectory();
    if (!isAbsolute(source) || /[\u0000-\u001f\u007f]/u.test(source))
      throw new Error(configurationInstruction);
    return source;
  } catch {
    throw new Error(configurationInstruction);
  }
}

function validToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || /[\u0000-\u001f\u007f]/u.test(token))
    throw new Error(`Local API credential is missing or invalid. ${configurationInstruction}`);
  return token;
}

/** Explicit tokens bypass every directory lookup and filesystem read. This never creates data. */
export function resolveClientCredential(
  options: ClientRuntimeOptions & {
    token?: string | undefined;
    readTokenFile?: ((path: string) => string) | undefined;
  } = {},
): ClientCredential {
  const token = options.token;
  if (token !== undefined) return { token: validToken(token), source: 'environment' };
  const directory = resolveClientDataDirectory(options);
  const credentialPath = join(directory, 'local-token');
  try {
    const token = validToken(
      options.readTokenFile
        ? options.readTokenFile(credentialPath)
        : readFileSync(credentialPath, 'utf8'),
    );
    return { token, source: 'file', credentialPath };
  } catch {
    throw new Error(`Local API credential is unavailable. ${configurationInstruction}`);
  }
}
