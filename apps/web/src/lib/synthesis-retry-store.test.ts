import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSynthesisRetryStore,
  decodeSynthesisRetrySnapshot,
  synthesisRetryKey,
} from './synthesis-retry-store';

const scope = {
  sessionId: '15000000-0000-4000-8000-000000000001',
  repositoryId: '15000000-0000-4000-8000-000000000002',
};
const input = {
  requestId: '15000000-0000-4000-8000-000000000003',
  expectedInputHash: 'a'.repeat(64),
};
function storageFixture() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('tab-scoped uncertain synthesis recovery', () => {
  it('restores the exact uncertain UUID/hash after a reload without performing network work or retaining evidence', () => {
    const { values, storage } = storageFixture();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const first = createSynthesisRetryStore(scope, () => storage);
    expect(first.getServerSnapshot()).toBe('');
    expect(first.save(input)).toBe(true);
    const serialized = values.get(first.key)!;
    expect(JSON.parse(serialized)).toEqual({ version: 1, ...scope, ...input });
    expect(serialized.length).toBeLessThan(1024);
    const reloaded = createSynthesisRetryStore(scope, () => storage);
    expect(decodeSynthesisRetrySnapshot(reloaded.getSnapshot(), scope).input).toEqual(input);
    expect(fetcher).not.toHaveBeenCalled();
    expect(reloaded.clear(input)).toBe(true);
    expect(values.has(first.key)).toBe(false);
  });

  it('isolates investigations/repositories and rejects corrupted, oversized or expanded stored records', () => {
    const { values, storage } = storageFixture();
    const store = createSynthesisRetryStore(scope, () => storage);
    store.save(input);
    const other = { ...scope, sessionId: input.requestId };
    expect(createSynthesisRetryStore(other, () => storage).getSnapshot()).toBe('');
    expect(decodeSynthesisRetrySnapshot(store.getSnapshot(), other).input).toBeNull();
    for (const value of [
      'not json',
      '{}',
      'x'.repeat(1025),
      JSON.stringify({ version: 1, ...scope, ...input, token: 'must-not-be-restored' }),
      JSON.stringify({ version: 1, ...scope, ...input, repositoryId: input.requestId }),
      JSON.stringify({ version: 1, ...scope, ...input, expectedInputHash: '../private' }),
    ]) {
      values.set(store.key, value);
      const result = decodeSynthesisRetrySnapshot(store.getSnapshot(), scope);
      expect(result.input).toBeNull();
      expect(result.notice).toContain('invalid');
      expect(result.notice).not.toContain('must-not-be-restored');
    }
    expect(() => synthesisRetryKey({ ...scope, sessionId: '../private' })).toThrow('valid');
  });

  it('does not erase a newer pending submission when an older response is confirmed', () => {
    const { storage } = storageFixture();
    const store = createSynthesisRetryStore(scope, () => storage);
    const newer = {
      requestId: '15000000-0000-4000-8000-000000000004',
      expectedInputHash: 'b'.repeat(64),
    };
    store.save(input);
    store.save(newer);
    expect(store.clear(input)).toBe(false);
    expect(decodeSynthesisRetrySnapshot(store.getSnapshot(), scope).input).toEqual(newer);
    expect(store.clear(newer)).toBe(true);
    expect(store.getSnapshot()).toBe('');
  });

  it('reports storage failure safely and allows explicit scoped reset without contacting the API', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const store = createSynthesisRetryStore(scope, () => {
      throw new Error('Private browser policy detail');
    });
    expect(store.save(input)).toBe(false);
    const result = decodeSynthesisRetrySnapshot(store.getSnapshot(), scope);
    expect(result.input).toBeNull();
    expect(result.notice).toContain('only on this page');
    expect(result.notice).not.toContain('Private browser policy detail');
    expect(store.clear(input)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const { storage } = storageFixture();
    const working = createSynthesisRetryStore(scope, () => storage);
    const notify = vi.fn();
    const unsubscribe = working.subscribe(notify);
    working.save(input);
    working.clear();
    expect(working.getSnapshot()).toBe('');
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    working.save(input);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
