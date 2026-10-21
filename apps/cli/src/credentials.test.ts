import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCredential, readToken } from './local.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CLI credential adapter', () => {
  it('reports an environment override without resolving invalid directory settings', () => {
    const token = 'synthetic-cli-client-private-token-at-least-32-characters';
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', token);
    vi.stubEnv('MEMVORA_DATA_DIR', 'invalid\u0000directory');
    expect(readCredential('invalid\u0000home')).toEqual({ token, source: 'environment' });
    expect(readToken()).toBe(token);
  });

  it('does not expose a missing configured credential file in CLI errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-cli-credentials-'));
    const privateMarker = 'PRIVATE_CREDENTIAL_PATH_FIXTURE';
    const dataDirectory = join(directory, privateMarker);
    mkdirSync(dataDirectory);
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', undefined);
    vi.stubEnv('MEMVORA_DATA_DIR', dataDirectory);
    try {
      let error;
      try {
        readToken();
      } catch (failure) {
        error = failure;
      }
      expect(String(error)).toContain('credential is unavailable');
      expect(String(error)).not.toContain(privateMarker);
      expect(String(error)).not.toContain('ENOENT');
    } finally {
      const target = resolve(directory);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('memvora-cli-credentials-')
      )
        throw new Error('Unexpected credential fixture cleanup target.');
      rmSync(target, { recursive: true, force: true });
    }
  });
});
