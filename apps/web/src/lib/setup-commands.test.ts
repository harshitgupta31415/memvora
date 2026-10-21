import { describe, expect, it } from 'vitest';
import {
  backupPowerShellCommands,
  nodePowerShellCommand,
  parseSetupQuery,
  quotePowerShellArgument,
} from './setup-commands';

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

describe('manual backup commands', () => {
  it('uses a fresh result variable and the exact create result for verification', () => {
    const commands = backupPowerShellCommands({
      wrapper: 'C:\\Memvora\\scripts\\with-resource-limits.ps1',
      envFile: 'C:\\Memvora\\.env',
      script: 'C:\\Memvora\\scripts\\backup-local.mjs',
      dataDirectory: "C:\\Developer's private data\\$env:TEMP; `whoami` # literal",
    });
    expect(commands.create).toContain('$memvoraBackup = $null\n$memvoraBackup = (');
    expect(commands.create).toContain(
      "& 'C:\\Memvora\\scripts\\with-resource-limits.ps1' node '--env-file-if-exists=C:\\Memvora\\.env' 'C:\\Memvora\\scripts\\backup-local.mjs' 'create' '--data-dir' 'C:\\Developer''s private data\\$env:TEMP; `whoami` # literal' | ConvertFrom-Json -ErrorAction Stop)",
    );
    expect(commands.create).toContain('$LASTEXITCODE -ne 0');
    expect(commands.create).not.toContain("'--output'");
    expect(commands.verify).toContain(
      "& 'C:\\Memvora\\scripts\\with-resource-limits.ps1' node '--env-file-if-exists=C:\\Memvora\\.env' 'C:\\Memvora\\scripts\\backup-local.mjs' 'verify' '--input' $memvoraBackup.directory",
    );
    expect(commands.verify).toContain('Run the create command in this PowerShell session first.');
    expect(commands.verify).toContain('$LASTEXITCODE -ne 0');
    expect(commands.verify).not.toContain('Get-ChildItem');
    expect(commands.verify).not.toContain('restore');
  });
});
