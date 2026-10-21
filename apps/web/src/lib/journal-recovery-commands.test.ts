import { describe, expect, it } from 'vitest';
import { journalRecoveryCommands, type JournalRecoveryInput } from './journal-recovery-commands';

const noteId = 'a0000000-0000-4000-8000-000000000003';
const input: JournalRecoveryInput = {
  directory: "C:\\Developer's projects\\$dollar; `whoami` # literal",
  state: 'pending',
  after: '',
  noteId: '',
};
const prefixes = {
  list: "& node 'C:\\Memvora\\apps\\cli\\dist\\index.js'",
  retry:
    "node '--env-file-if-exists=C:\\Memvora\\.env' 'C:\\Memvora\\apps\\cli\\dist\\index.js' '--api-url' 'http://127.0.0.1:4000' '--home' 'C:\\Private' 'journal' 'retry'",
};

describe('manual authored-journal recovery commands', () => {
  it('lists offline with a literal folder and no upload or server configuration', () => {
    const result = journalRecoveryCommands(input, { list: prefixes.list, retry: null });
    expect(result.listCommand).toBe(
      "& node 'C:\\Memvora\\apps\\cli\\dist\\index.js' 'journal' 'list' '--directory' 'C:\\Developer''s projects\\$dollar; `whoami` # literal' '--state' 'pending' '--limit' '20'",
    );
    expect(result.listCommand).not.toMatch(/--env-file|--api-url|--home|--text|retry/u);
    expect(result.retryCommand).toBeNull();
  });

  it('accepts only journal states and safe live-page row cursors', () => {
    for (const state of ['pending', 'synced', 'all']) {
      const result = journalRecoveryCommands({ ...input, state, after: '17' }, prefixes);
      expect(result.listCommand).toContain(`'--state' '${state}' '--limit' '20' '--after' '17'`);
    }
    for (const state of ['unsynced', 'incomplete', 'all --force', ''])
      expect(journalRecoveryCommands({ ...input, state }, prefixes).listCommand).toBeNull();
    for (const after of ['0', '-1', '1; whoami', '1.5', ' 1', '01', '9007199254740992'])
      expect(journalRecoveryCommands({ ...input, after }, prefixes).listCommand).toBeNull();
  });

  it('rejects unsafe folders for both operations rather than changing the selected location', () => {
    for (const directory of [
      '.',
      ' ',
      'C:relative',
      '\\\\server\\share',
      'C:\\repo\nsecond-line',
      'C:\\bad:stream',
      'C:\\wild*card',
      `C:\\${'a'.repeat(2048)}`,
    ]) {
      const result = journalRecoveryCommands({ ...input, directory, noteId }, prefixes);
      expect(result.listCommand).toBeNull();
      expect(result.retryCommand).toBeNull();
    }
  });

  it('keeps listing and exact selected-note retry independent', () => {
    const malformedNote = journalRecoveryCommands({ ...input, noteId: 'all' }, prefixes);
    expect(malformedNote.listCommand).not.toBeNull();
    expect(malformedNote.retryCommand).toBeNull();

    const malformedList = journalRecoveryCommands(
      { ...input, state: 'invalid', after: '0', noteId },
      prefixes,
    );
    expect(malformedList.listCommand).toBeNull();
    expect(malformedList.retryCommand).toContain(`${prefixes.retry} '--note' '${noteId}'`);
    expect(
      journalRecoveryCommands({ ...input, noteId: `${noteId}; whoami` }, prefixes).retryCommand,
    ).toBeNull();
    expect(
      journalRecoveryCommands({ ...input, noteId }, { ...prefixes, retry: null }).retryCommand,
    ).toBeNull();
  });

  it('retries only one original UUID inside its capture folder and restores the shell location', () => {
    const result = journalRecoveryCommands(
      { ...input, noteId, state: 'synced', after: '17' },
      prefixes,
    );
    expect(result.retryCommand).toBe(
      [
        '& {',
        "  Push-Location -LiteralPath 'C:\\Developer''s projects\\$dollar; `whoami` # literal' -ErrorAction Stop",
        '  try {',
        `    ${prefixes.retry} '--note' '${noteId}'`,
        '  } finally { Pop-Location }',
        '}',
      ].join('\n'),
    );
    expect(result.retryCommand).not.toMatch(
      /--state|--after|--text|--queue|--force|--session|init/u,
    );
  });
});
