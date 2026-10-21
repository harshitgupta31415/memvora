import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveClientCredential, resolveClientDataDirectory } from './client-runtime.js';

const token = 'synthetic-private-client-fixture-token-at-least-32-characters';
const home = resolve('synthetic-client-data-directory');

describe('portable client configuration', () => {
  it('fails missing portable configuration before any source lookup or filesystem read', () => {
    const sourceDataDirectory = vi.fn(() => {
      throw new Error('Source fallback must not run.');
    });
    const readTokenFile = vi.fn(() => token);
    expect(() =>
      resolveClientCredential({ portable: true, sourceDataDirectory, readTokenFile }),
    ).toThrow('absolute server data directory');
    expect(sourceDataDirectory).not.toHaveBeenCalled();
    expect(readTokenFile).not.toHaveBeenCalled();
  });

  it.each(['', ' ', 'relative-directory', '.', '..', 'C:relative', `${home}\u0000private`])(
    'rejects explicit invalid portable home %j without source fallback or file reads',
    (selected) => {
      const sourceDataDirectory = vi.fn(() => home);
      const readTokenFile = vi.fn(() => token);
      expect(() =>
        resolveClientCredential({
          portable: true,
          home: selected,
          sourceDataDirectory,
          readTokenFile,
        }),
      ).toThrow('absolute server data directory');
      expect(sourceDataDirectory).not.toHaveBeenCalled();
      expect(readTokenFile).not.toHaveBeenCalled();
    },
  );

  it('treats an explicitly empty environment directory as invalid instead of the cwd', () => {
    expect(() =>
      resolveClientDataDirectory({
        portable: true,
        dataDirectory: '',
        sourceDataDirectory: () => home,
      }),
    ).toThrow('absolute server data directory');
  });

  it('uses the explicit absolute home before an environment directory and reports the exact token file', () => {
    const readTokenFile = vi.fn(() => `${token}\n`);
    const sourceDataDirectory = vi.fn(() => {
      throw new Error('Source fallback must not run.');
    });
    const credential = resolveClientCredential({
      portable: true,
      home,
      dataDirectory: resolve('other-fixture-data'),
      sourceDataDirectory,
      readTokenFile,
    });
    expect(credential).toEqual({
      source: 'file',
      token,
      credentialPath: join(home, 'local-token'),
    });
    expect(readTokenFile).toHaveBeenCalledExactlyOnceWith(join(home, 'local-token'));
    expect(sourceDataDirectory).not.toHaveBeenCalled();
    expect(resolveClientDataDirectory({ portable: true, dataDirectory: home })).toBe(home);
  });

  it('accepts a token without evaluating directory getters, source fallback or the filesystem', () => {
    const directory = vi.fn(() => {
      throw new Error('A token must bypass directory configuration.');
    });
    const readTokenFile = vi.fn(() => {
      throw new Error('A token must bypass filesystem access.');
    });
    const result = resolveClientCredential({
      portable: true,
      token,
      get home() {
        return directory();
      },
      get dataDirectory() {
        return directory();
      },
      sourceDataDirectory: directory,
      readTokenFile,
    });
    expect(result).toEqual({ token, source: 'environment' });
    expect(directory).not.toHaveBeenCalled();
    expect(readTokenFile).not.toHaveBeenCalled();
    expect(Object.hasOwn(result, 'credentialPath')).toBe(false);
  });

  it.each(['', 'short-private-fixture', `${token}\nprivate`])(
    'does not fall back from an invalid explicit token %j',
    (invalidToken) => {
      const readTokenFile = vi.fn(() => token);
      const sourceDataDirectory = vi.fn(() => home);
      expect(() =>
        resolveClientCredential({
          portable: true,
          token: invalidToken,
          home,
          sourceDataDirectory,
          readTokenFile,
        }),
      ).toThrow('missing or invalid');
      expect(readTokenFile).not.toHaveBeenCalled();
      expect(sourceDataDirectory).not.toHaveBeenCalled();
    },
  );

  it('hides filesystem exceptions, paths and invalid file content behind safe instructions', () => {
    const privateMarker = 'PRIVATE_FIXTURE_MUST_NOT_APPEAR';
    for (const readTokenFile of [
      () => {
        throw new Error(`EACCES ${privateMarker}`);
      },
      () => privateMarker,
    ]) {
      let error;
      try {
        resolveClientCredential({ portable: true, home: resolve(privateMarker), readTokenFile });
      } catch (failure) {
        error = failure;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('credential is unavailable');
      expect(String(error)).not.toContain(privateMarker);
      expect(String(error)).not.toContain('EACCES');
    }
  });
});

describe('source checkout client configuration', () => {
  it('evaluates its original source fallback only on an actual unconfigured source credential read', () => {
    const sourceDataDirectory = vi.fn(() => home);
    const readTokenFile = vi.fn(() => token);
    resolveClientCredential({ portable: false, token, sourceDataDirectory, readTokenFile });
    expect(sourceDataDirectory).not.toHaveBeenCalled();
    expect(readTokenFile).not.toHaveBeenCalled();
    expect(
      resolveClientCredential({ portable: false, sourceDataDirectory, readTokenFile }),
    ).toEqual({ source: 'file', token, credentialPath: join(home, 'local-token') });
    expect(sourceDataDirectory).toHaveBeenCalledOnce();
    expect(
      resolveClientDataDirectory({
        portable: false,
        home: 'source-relative-override',
        sourceDataDirectory,
      }),
    ).toBe(resolve('source-relative-override'));
    expect(sourceDataDirectory).toHaveBeenCalledOnce();
  });
});
