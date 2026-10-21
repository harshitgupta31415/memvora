import { describe, expect, it } from 'vitest';
import { captureRecoveryCommands, type RecoveryInput } from './capture-recovery-commands';

const sessionId = 'a0000000-0000-4000-8000-000000000001';
const eventId = 'a0000000-0000-4000-8000-000000000002';
const input: RecoveryInput = {
  directory: "C:\\Developer's projects\\$dollar; `whoami` # literal",
  state: 'unsynced',
  sessionId: '',
  after: '',
  syncKind: 'session',
  syncId: '',
};
const prefixes = {
  list: "node 'C:\\Memvora\\apps\\cli\\dist\\index.js'",
  sync: "node 'C:\\Memvora\\apps\\cli\\dist\\index.js' '--api-url' 'http://127.0.0.1:4000' '--home' 'C:\\Private' 'sync'",
};

describe('manual capture-recovery commands', () => {
  it('can list offline without a selection or API prefix and quotes the folder literally', () => {
    const result = captureRecoveryCommands(input, { ...prefixes, sync: null });
    expect(result.listCommand).toBe(
      "node 'C:\\Memvora\\apps\\cli\\dist\\index.js' 'outbox' 'list' '--directory' 'C:\\Developer''s projects\\$dollar; `whoami` # literal' '--state' 'unsynced' '--limit' '20'",
    );
    expect(result.syncCommand).toBeNull();
  });

  it('uses exact row and session filters without silently accepting malformed selectors', () => {
    const result = captureRecoveryCommands({ ...input, sessionId, after: '17' }, prefixes);
    expect(result.listCommand).toContain(`'--session' '${sessionId}' '--after' '17'`);
    for (const after of ['0', '-1', '1; whoami', '9007199254740992'])
      expect(captureRecoveryCommands({ ...input, after }, prefixes).listCommand).toBeNull();
    expect(
      captureRecoveryCommands({ ...input, sessionId: 'all' }, prefixes).listCommand,
    ).toBeNull();
    expect(
      captureRecoveryCommands({ ...input, state: 'all --force' }, prefixes).listCommand,
    ).toBeNull();
  });

  it('never emits upload commands for an unsafe path or malformed selected UUID', () => {
    for (const directory of [
      '.',
      ' ',
      'C:relative',
      '\\\\server\\share',
      'C:\\repo\nsecond-line',
      'C:\\bad:stream',
      `C:\\${'a'.repeat(2048)}`,
    ]) {
      const result = captureRecoveryCommands({ ...input, directory, syncId: eventId }, prefixes);
      expect(result.listCommand).toBeNull();
      expect(result.syncCommand).toBeNull();
    }
    expect(
      captureRecoveryCommands({ ...input, syncId: `${eventId}; whoami` }, prefixes).syncCommand,
    ).toBeNull();
    expect(
      captureRecoveryCommands({ ...input, syncId: eventId, syncKind: 'event --session' }, prefixes)
        .syncCommand,
    ).toBeNull();
  });

  it('runs only one explicit upload selection inside the folder and restores the location', () => {
    const result = captureRecoveryCommands(
      { ...input, sessionId, syncKind: 'event', syncId: eventId },
      prefixes,
    );
    expect(result.syncCommand).toContain(
      "Push-Location -LiteralPath 'C:\\Developer''s projects\\$dollar; `whoami` # literal' -ErrorAction Stop",
    );
    expect(result.syncCommand).toContain(`${prefixes.sync} '--event' '${eventId}'`);
    expect(result.syncCommand).toContain('finally { Pop-Location }');
    expect(result.syncCommand).not.toContain("'--session'");
    expect(result.syncCommand).not.toContain('force');
    expect(result.syncCommand).not.toContain('init');
  });
});
