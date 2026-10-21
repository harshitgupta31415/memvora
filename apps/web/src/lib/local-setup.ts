import 'server-only';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  backupPowerShellCommands,
  nodePowerShellCommand,
  quotePowerShellArgument,
} from './setup-commands';

export function localSetupPaths() {
  const root = resolve(process.cwd(), '../..');
  return {
    root,
    envFile: resolve(root, '.env'),
    cli: resolve(root, 'apps/cli/dist/index.js'),
    mcp: resolve(root, 'apps/mcp/dist/index.js'),
    wrapper: resolve(root, 'scripts/with-resource-limits.ps1'),
    doctor: resolve(root, 'scripts/doctor.mjs'),
  };
}

export function localRuntimeConfiguration():
  | { ok: true; apiUrl: string; dataDirectory: string; externalCredential: boolean }
  | { ok: false; message: string } {
  try {
    const api = new URL(process.env.MEMVORA_API_URL ?? 'http://127.0.0.1:4000');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname) ||
      !['http:', 'https:'].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.pathname !== '/' ||
      api.search ||
      api.hash
    )
      throw new Error('Invalid API origin');
    const dataDirectory =
      process.env.MEMVORA_DATA_DIR ?? resolve(localSetupPaths().root, '.memvora');
    if (!isAbsolute(dataDirectory) || /[\u0000-\u001f\u007f]/u.test(dataDirectory))
      throw new Error('Invalid data directory');
    return {
      ok: true,
      apiUrl: api.origin,
      dataDirectory,
      externalCredential: Boolean(process.env.MEMVORA_LOCAL_TOKEN?.trim()),
    };
  } catch {
    return {
      ok: false,
      message:
        'Local setup requires a plain loopback API origin and an absolute data-directory path. Correct the server configuration and restart before copying commands.',
    };
  }
}

export function localCliCommand(args: readonly string[]): string | null {
  const paths = localSetupPaths();
  const configuration = localRuntimeConfiguration();
  if (!configuration.ok) return null;
  return nodePowerShellCommand(paths.envFile, paths.cli, [
    '--api-url',
    configuration.apiUrl,
    '--home',
    configuration.dataDirectory,
    ...args,
  ]);
}

export function localDoctorCommand(): string {
  const paths = localSetupPaths();
  return nodePowerShellCommand(paths.envFile, paths.doctor);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(/* turbopackIgnore: true */ path)).isFile();
  } catch {
    return false;
  }
}

export async function localSetupDetails() {
  const configuration = localRuntimeConfiguration();
  if (!configuration.ok) return configuration;
  const paths = localSetupPaths();
  const [cliBuilt, mcpBuilt] = await Promise.all([isFile(paths.cli), isFile(paths.mcp)]);
  return {
    ...configuration,
    paths,
    cliBuilt,
    mcpBuilt,
    changeDirectory: `Set-Location -LiteralPath ${quotePowerShellArgument(paths.root)}`,
    install: `& ${quotePowerShellArgument(paths.wrapper)} npm.cmd ci`,
    build: `& ${quotePowerShellArgument(paths.wrapper)} npm.cmd run build`,
    start: `& ${quotePowerShellArgument(paths.wrapper)} npm.cmd run start:local`,
    cliCommand: (args: readonly string[]) =>
      nodePowerShellCommand(paths.envFile, paths.cli, [
        '--api-url',
        configuration.apiUrl,
        '--home',
        configuration.dataDirectory,
        ...args,
      ]),
    mcpConfiguration: JSON.stringify(
      {
        mcpServers: {
          memvora: {
            command: 'node',
            args: [`--env-file-if-exists=${paths.envFile}`, paths.mcp],
            env: {
              MEMVORA_API_URL: configuration.apiUrl,
              MEMVORA_DATA_DIR: configuration.dataDirectory,
            },
          },
        },
      },
      null,
      2,
    ),
  };
}

export async function localBackupDetails() {
  const configuration = localRuntimeConfiguration();
  if (!configuration.ok) return configuration;
  if (/^[/\\]{2}/u.test(configuration.dataDirectory))
    return {
      ok: false as const,
      message:
        'Manual backups require an absolute local data directory. Network paths are not supported by the backup utility.',
    };
  const paths = localSetupPaths();
  const script = resolve(paths.root, 'scripts/backup-local.mjs');
  const backupEntry = resolve(paths.root, 'packages/db/dist/local-backup.js');
  const source = resolve(configuration.dataDirectory, 'server.sqlite');
  const [scriptPresent, databaseBuilt, sourcePresent] = await Promise.all([
    isFile(script),
    isFile(backupEntry),
    isFile(source),
  ]);
  return {
    ...configuration,
    source,
    defaultDestination: resolve(configuration.dataDirectory, 'backups'),
    scriptPresent,
    databaseBuilt,
    sourcePresent,
    commands: backupPowerShellCommands({
      wrapper: paths.wrapper,
      envFile: paths.envFile,
      script,
      dataDirectory: configuration.dataDirectory,
    }),
  };
}
