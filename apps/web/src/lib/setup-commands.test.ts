import { describe, expect, it } from 'vitest';
import { nodePowerShellCommand, parseSetupQuery, quotePowerShellArgument } from './setup-commands';

const repositoryId = 'a0000000-0000-4000-8000-000000000001';

describe('local setup query scope', () => {
  it('allows only the unscoped guide or one explicit repository UUID', () => {
    expect(parseSetupQuery({})).toEqual({ ok: true });
    expect(parseSetupQuery({ repositoryId })).toEqual({ ok: true, repositoryId });
  });

  it('does not widen a malformed or duplicated repository selection', () => {
    for (const parameters of [
      { repositoryId: '' },
      { repositoryId: 'all' },
      { repositoryId: ` ${repositoryId}` },
      { repositoryId: [repositoryId, repositoryId] },
      { repositoryId, token: 'do-not-adopt-this' },
      { unknown: 'value' },
    ]) {
      expect(parseSetupQuery(parameters)).toEqual({ ok: false });
    }
  });
});

describe('PowerShell command argument safety', () => {
  it('keeps apostrophes and expansion syntax inside a single literal argument', () => {
    const path = "C:\\Developer's projects\\$env:TEMP; `whoami` # literal\\index.js";
    expect(quotePowerShellArgument(path)).toBe(
      "'C:\\Developer''s projects\\$env:TEMP; `whoami` # literal\\index.js'",
    );
    expect(quotePowerShellArgument('')).toBe("''");
  });

  it('places the absolute env file before the entry and retains each CLI boundary', () => {
    expect(
      nodePowerShellCommand(
        "C:\\Developer's projects\\memvora\\.env",
        'C:\\Memvora\\apps\\cli\\dist\\index.js',
        [
          '--api-url',
          'http://127.0.0.1:49001',
          '--home',
          'C:\\Private evidence',
          'run',
          '--',
          'npm',
          'test',
        ],
      ),
    ).toBe(
      "node '--env-file-if-exists=C:\\Developer''s projects\\memvora\\.env' 'C:\\Memvora\\apps\\cli\\dist\\index.js' '--api-url' 'http://127.0.0.1:49001' '--home' 'C:\\Private evidence' 'run' '--' 'npm' 'test'",
    );
  });
});
