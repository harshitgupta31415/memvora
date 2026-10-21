import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBackupWorker } from './lib/backup-process.mjs';

// Local operator entry point. Normal web/CLI/MCP evidence clients still use the API.
const root = resolve(import.meta.dirname, '..');
const help = `Memvora local database backup

  node scripts/backup-local.mjs create [--data-dir <absolute-directory>] [--output <new-absolute-directory>]
  node scripts/backup-local.mjs verify --input <absolute-backup-directory>

Create takes a consistent complete SQLite snapshot into a new directory and writes its
completion manifest only after verification. The default destination is a new directory
inside <data-dir>/backups. Existing destinations are never reused or overwritten.
Verify checks an existing snapshot read-only; it does not restore or run jobs.

Use a private local folder. Snapshots contain private evidence and encrypted GitHub
state, but exclude the external API token, environment files and CLI outboxes.
No upload, automatic retention, live replacement or credential creation is performed.
`;

function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  const [command, ...remaining] = args;
  if (!['create', 'verify'].includes(command)) throw new Error('Use create, verify or --help.');
  const allowed = command === 'create' ? ['--data-dir', '--output'] : ['--input'];
  const options = {};
  for (let index = 0; index < remaining.length; index += 2) {
    const flag = remaining[index];
    const value = remaining[index + 1];
    if (!allowed.includes(flag) || Object.hasOwn(options, flag))
      throw new Error('Unknown or duplicate backup option. Use --help for exact arguments.');
    if (
      !value ||
      value.startsWith('--') ||
      !isAbsolute(value) ||
      /^[/\\]{2}/u.test(value) ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      throw new Error('Each backup option requires one absolute local filesystem path.');
    options[flag] = value;
  }
  if (command === 'verify' && !options['--input'])
    throw new Error('Verification requires --input with an absolute backup-directory path.');
  return { command, options };
}

function existingDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('A regular existing local directory is required.');
}

function defaultDestination(dataDirectory) {
  existingDirectory(dataDirectory);
  const source = lstatSync(resolve(dataDirectory, 'server.sqlite'));
  if (!source.isFile() || source.isSymbolicLink())
    throw new Error(
      'An existing regular server.sqlite file is required. Start the local API first.',
    );
  const parent = resolve(dataDirectory, 'backups');
  try {
    mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  existingDirectory(parent);
  try {
    writeFileSync(resolve(parent, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  return resolve(
    parent,
    `snapshot-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID()}`,
  );
}

async function operate(parsed) {
  const { createLocalBackup, verifyLocalBackup, resolveLocalBackupDataDirectory } =
    await import('../packages/db/dist/local-backup.js');
  if (parsed.command === 'create') {
    const configured =
      parsed.options['--data-dir'] ?? process.env.MEMVORA_DATA_DIR ?? resolve(root, '.memvora');
    if (
      !isAbsolute(configured) ||
      /^[/\\]{2}/u.test(configured) ||
      /[\u0000-\u001f\u007f]/u.test(configured)
    )
      throw new Error('Configure an absolute local data directory.');
    const dataDirectory = resolveLocalBackupDataDirectory(configured);
    const outputDirectory = parsed.options['--output'] ?? defaultDestination(dataDirectory);
    const result = await createLocalBackup({ dataDirectory, outputDirectory });
    console.log(
      JSON.stringify(
        {
          status: 'created_and_verified',
          directory: result.directory,
          manifest: result.manifest,
        },
        null,
        2,
      ),
    );
  } else {
    const directory = resolve(parsed.options['--input']);
    const manifest = await verifyLocalBackup(directory);
    console.log(
      JSON.stringify(
        { status: 'verified', directory, manifest, liveRestorePerformed: false },
        null,
        2,
      ),
    );
  }
}

try {
  const args = process.argv.slice(2);
  const parsed = parseArguments(args);
  if (parsed.command === 'help') process.stdout.write(help);
  else if (typeof process.send === 'function') await operate(parsed);
  else {
    const result = await runBackupWorker(fileURLToPath(import.meta.url), args);
    if (result.timedOut || result.interrupted || result.overflow) {
      const code = result.timedOut
        ? 'BACKUP_TIMEOUT'
        : result.interrupted
          ? 'BACKUP_INTERRUPTED'
          : 'BACKUP_OUTPUT_LIMIT';
      throw Object.assign(new Error('The backup worker could not complete.'), { code });
    }
    if (result.code !== 0 || result.signal) {
      if (result.stderr) process.stderr.write(result.stderr);
      else throw new Error('The backup worker failed.');
      process.exitCode = 1;
    } else {
      // Publish a complete result only after the supervised worker exits successfully.
      const output = JSON.parse(result.stdout);
      if (!['created_and_verified', 'verified'].includes(output.status))
        throw new Error('The backup worker returned an invalid completion result.');
      process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
} catch (error) {
  // Do not expose database exception text, SQL, file contents or path-derived secrets.
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z_]{3,60}$/u.test(error.code)
      ? error.code
      : 'BACKUP_OPERATION_FAILED';
  console.error(
    JSON.stringify({
      error: {
        code,
        message:
          'The local backup operation could not be confirmed. Check arguments, build files, private local paths and database integrity; any existing or incomplete files were retained.',
      },
    }),
  );
  process.exitCode = 1;
}
