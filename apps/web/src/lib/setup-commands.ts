import { IdSchema } from '@memvora/contracts';
import { Compile } from 'typebox/compile';

export function quotePowerShellArgument(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function nodePowerShellCommand(
  envFile: string,
  entry: string,
  args: readonly string[] = [],
): string {
  return ['node', `--env-file-if-exists=${envFile}`, entry, ...args]
    .map((value, index) => (index === 0 ? value : quotePowerShellArgument(value)))
    .join(' ');
}

export function backupPowerShellCommands(paths: {
  wrapper: string;
  envFile: string;
  script: string;
  dataDirectory: string;
}): { create: string; verify: string } {
  const operator = (args: readonly string[]) =>
    `& ${quotePowerShellArgument(paths.wrapper)} ${nodePowerShellCommand(paths.envFile, paths.script, args)}`;
  return {
    create: [
      '$memvoraBackup = $null',
      `$memvoraBackup = (${operator(['create', '--data-dir', paths.dataDirectory])} | ConvertFrom-Json -ErrorAction Stop)`,
      "if ($LASTEXITCODE -ne 0 -or $null -eq $memvoraBackup -or [string]::IsNullOrWhiteSpace([string]$memvoraBackup.directory)) { throw 'Backup creation failed. Review the terminal error.' }",
    ].join('\n'),
    verify: [
      "if ($null -eq $memvoraBackup -or [string]::IsNullOrWhiteSpace([string]$memvoraBackup.directory)) { throw 'Run the create command in this PowerShell session first.' }",
      `${operator(['verify', '--input'])} $memvoraBackup.directory`,
      "if ($LASTEXITCODE -ne 0) { throw 'Backup verification failed. Keep the original database and review the error.' }",
    ].join('\n'),
  };
}

export function parseSetupQuery(
  parameters: Record<string, string | string[] | undefined>,
): { ok: true; repositoryId?: string } | { ok: false } {
  if (Object.keys(parameters).some((key) => key !== 'repositoryId')) return { ok: false };
  const repositoryId = parameters.repositoryId;
  if (repositoryId === undefined) return { ok: true };
  return typeof repositoryId === 'string' && Compile(IdSchema).Check(repositoryId)
    ? { ok: true, repositoryId }
    : { ok: false };
}
