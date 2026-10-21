import { Compile } from 'typebox/compile';
import {
  CreateSessionSynthesisSchema,
  IdSchema,
  type CreateSessionSynthesis,
} from '@memvora/contracts';

export type SynthesisRetryScope = { sessionId: string; repositoryId: string };
type RetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const unavailable = '!storage-unavailable';
const invalid = '!invalid-record';
const maximumLength = 1024;

export function synthesisRetryKey(scope: SynthesisRetryScope): string {
  if (!Compile(IdSchema).Check(scope.sessionId) || !Compile(IdSchema).Check(scope.repositoryId))
    throw new Error('A valid investigation and repository are required for retry recovery.');
  return `memvora.synthesis.pending.v1:${scope.repositoryId}:${scope.sessionId}`;
}

export function decodeSynthesisRetrySnapshot(
  raw: string,
  scope: SynthesisRetryScope,
): { input: CreateSessionSynthesis | null; notice: string | null } {
  if (!raw) return { input: null, notice: null };
  if (raw === unavailable)
    return {
      input: null,
      notice:
        'Tab storage is unavailable. Retry identity is retained only on this page; copy the request ID and input hash before leaving.',
    };
  const corrupt = {
    input: null,
    notice:
      'Saved retry metadata is invalid or belongs to another investigation. It was not submitted. Use retained history to locate accepted requests, or explicitly review latest input.',
  };
  if (raw === invalid || raw.length > maximumLength) return corrupt;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'expectedInputHash,repositoryId,requestId,sessionId,version'
    )
      return corrupt;
    const record = value as Record<string, unknown>;
    const input = { requestId: record.requestId, expectedInputHash: record.expectedInputHash };
    if (
      record.version !== 1 ||
      record.sessionId !== scope.sessionId ||
      record.repositoryId !== scope.repositoryId ||
      !Compile(CreateSessionSynthesisSchema).Check(input)
    )
      return corrupt;
    return { input, notice: null };
  } catch {
    return corrupt;
  }
}

/** No network actions: this store retains only an uncertain submission's scoped UUID and hash. */
export function createSynthesisRetryStore(scope: SynthesisRetryScope, storage: () => RetryStorage) {
  const key = synthesisRetryKey(scope);
  const listeners = new Set<() => void>();
  let broken = false;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    key,
    getServerSnapshot: () => '',
    getSnapshot: () => {
      if (broken) return unavailable;
      try {
        const value = storage().getItem(key) ?? '';
        return value.length <= maximumLength ? value : invalid;
      } catch {
        return unavailable;
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      const changed = (event: StorageEvent) => {
        if (event.key === key || event.key === null) listener();
      };
      if (typeof window !== 'undefined') window.addEventListener('storage', changed);
      return () => {
        listeners.delete(listener);
        if (typeof window !== 'undefined') window.removeEventListener('storage', changed);
      };
    },
    save: (input: CreateSessionSynthesis): boolean => {
      if (!Compile(CreateSessionSynthesisSchema).Check(input))
        throw new Error('Only a valid request UUID and reviewed hash can be retained.');
      try {
        storage().setItem(key, JSON.stringify({ version: 1, ...scope, ...input }));
        broken = false;
        notify();
        return true;
      } catch {
        broken = true;
        notify();
        return false;
      }
    },
    clear: (expected?: CreateSessionSynthesis): boolean => {
      try {
        const current = storage().getItem(key);
        if (current === null) {
          broken = false;
          notify();
          return true;
        }
        if (expected) {
          const parsed = decodeSynthesisRetrySnapshot(current, scope).input;
          if (
            !parsed ||
            parsed.requestId !== expected.requestId ||
            parsed.expectedInputHash !== expected.expectedInputHash
          )
            return false;
        }
        storage().removeItem(key);
        broken = false;
        notify();
        return true;
      } catch {
        broken = true;
        notify();
        return false;
      }
    },
  };
}
