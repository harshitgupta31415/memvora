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
