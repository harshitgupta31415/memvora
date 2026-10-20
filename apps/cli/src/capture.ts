import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { CapturedEvent } from '@memvora/contracts';
import { LocalOutbox } from './local.js';
import { redactArguments, redactText, StreamRedactor } from './redaction.js';

const OUTPUT_LIMIT = 128 * 1024;
const DIFF_LIMIT = 32 * 1024;
const TEXT_CHUNK_LIMIT = 8 * 1024;
const COMMAND_JSON_LIMIT = 128 * 1024;
export const FINAL_EVENT_JSON_LIMIT = 480 * 1024;

export async function gitText(
  cwd: string,
  args: string[],
  limit = DIFF_LIMIT,
): Promise<{ text: string; truncatedBytes: number; ok: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let stored = 0;
    let truncatedBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      const available = Math.max(0, limit - stored);
      if (available) chunks.push(chunk.subarray(0, available));
      stored += Math.min(available, chunk.length);
      truncatedBytes += Math.max(0, chunk.length - available);
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ text: '', truncatedBytes: 0, ok: false });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString('utf8'), truncatedBytes, ok: code === 0 });
    });
  });
}

export function resolveInvocation(
  executable: string,
  args: string[],
  shell?: string,
): { executable: string; args: string[]; shell: string } {
  if (shell) {
    if (args.length)
      throw new Error('Explicit shell mode accepts one quoted command string after --.');
    if (shell === 'powershell')
      return {
        executable: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', executable],
        shell,
      };
    if (shell === 'cmd')
      return {
        executable: process.env['ComSpec'] ?? 'cmd.exe',
        args: ['/d', '/s', '/v:off', '/c', executable],
        shell,
      };
    throw new Error('Supported explicit shells: powershell or cmd.');
  }
  if (process.platform === 'win32' && /^(?:npm|npx)(?:\.cmd)?$/i.test(executable)) {
    const cli = /^npx/i.test(executable) ? 'npx-cli.js' : 'npm-cli.js';
    const candidates = [dirname(process.execPath), ...(process.env['PATH'] ?? '').split(delimiter)];
    for (const folder of candidates) {
      const path = join(folder, 'node_modules', 'npm', 'bin', cli);
      if (existsSync(path))
        return { executable: process.execPath, args: [path, ...args], shell: 'direct-node-npm' };
    }
    throw new Error(
      'Unable to locate the npm JavaScript entry point. Use explicit --shell cmd with one quoted command string.',
    );
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    throw new Error(
      'Windows batch files require explicit --shell cmd with one quoted command string.',
    );
  }
  return { executable, args, shell: 'direct' };
}

function safePrefix(text: string, bytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text;
  let end = Math.min(text.length, bytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > bytes) end--;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}

function jsonPrefix(text: string, byteLimit: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle)), 'utf8') <= byteLimit) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(text[low - 1] ?? '')) low--;
  return text.slice(0, low);
}

/** Keep transport JSON below the API cap, including escaping overhead. Only evidence text is shortened. */
export function fitEventEnvelope(event: CapturedEvent): CapturedEvent {
  const fields: Array<{ item: { text: string }; omit: (bytes: number) => void }> = event.output.map(
    (chunk) => ({
      item: chunk,
      omit: (bytes: number) => {
        event.capture.truncatedBytes += bytes;
      },
    }),
  );
  fields.push(
    ...event.diffs.map((diff) => ({
      item: diff,
      omit: (bytes: number) => {
        diff.truncatedBytes += bytes;
      },
    })),
  );
  let encodedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  while (encodedBytes > FINAL_EVENT_JSON_LIMIT) {
    const largest = fields
      .filter((field) => field.item.text.length > 0)
      .sort(
        (left, right) =>
          Buffer.byteLength(JSON.stringify(right.item.text), 'utf8') -
          Buffer.byteLength(JSON.stringify(left.item.text), 'utf8'),
      )[0];
    if (!largest)
      throw new Error(
        'Captured metadata exceeds the supported event limit; evidence remains local for inspection.',
      );
    const original = largest.item.text;
    const targetBytes = Math.max(
      2,
      Buffer.byteLength(JSON.stringify(original), 'utf8') - (encodedBytes - FINAL_EVENT_JSON_LIMIT),
    );
    largest.item.text = jsonPrefix(original, targetBytes);
    largest.omit(
      Buffer.byteLength(original, 'utf8') - Buffer.byteLength(largest.item.text, 'utf8'),
    );
    event.capture.complete = false;
    encodedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  }
  if (event.diffs.some((diff) => diff.truncatedBytes > 0)) event.capture.complete = false;
  return event;
}

async function snapshotDiff(
  cwd: string,
  token: string,
): Promise<{ text: string; truncatedBytes: number }> {
  const result = await gitText(cwd, [
    'diff',
    'HEAD',
    '--no-ext-diff',
    '--no-color',
    '--',
    '.',
    ':(exclude)**/.env*',
    ':(exclude).env*',
    ':(exclude)**/*.pem',
    ':(exclude)**/*.key',
    ':(exclude)**/credentials*',
    ':(exclude)**/.npmrc',
    ':(exclude)**/.pypirc',
    ':(exclude)**/.netrc',
    ':(exclude)**/id_rsa*',
    ':(exclude)**/id_ed25519*',
    ':(exclude)**/.memvora/**',
    ':(exclude).memvora/**',
  ]);
  return { text: redactText(result.text, [token]), truncatedBytes: result.truncatedBytes };
}

export async function captureCommand(options: {
  cwd: string;
  repositoryId: string;
  sessionId: string;
  outbox: LocalOutbox;
  token: string;
  command: string[];
  shell?: string;
  databasePath: string;
}): Promise<{ eventId: string; exitCode: number }> {
  const executable = options.command[0];
  if (!executable) throw new Error('Provide an executable after --.');
  if (
    Buffer.byteLength(
      JSON.stringify({
        executable,
        args: options.command.slice(1),
        shell: options.shell ?? 'direct',
      }),
      'utf8',
    ) > COMMAND_JSON_LIMIT
  )
    throw new Error(
      'Command metadata exceeds the 128 KiB JSON limit. No command was executed or capture started.',
    );
  if (existsSync(options.databasePath) && statSync(options.databasePath).size > 500 * 1024 * 1024)
    throw new Error(
      'Local outbox exceeds 500 MiB. Sync or explicitly clean up before capturing more.',
    );
  const eventId = randomUUID();
  const startedAt = new Date().toISOString();
  const sha = await gitText(options.cwd, ['rev-parse', 'HEAD']);
  const dirty = await gitText(options.cwd, ['status', '--porcelain'], 1024);
  const before = await snapshotDiff(options.cwd, options.token);
  const initial = {
    eventId,
    repositoryId: options.repositoryId,
    sessionId: options.sessionId,
    startedAt,
    command: {
      executable: redactText(executable, [options.token]),
      args: redactArguments(options.command.slice(1), [options.token]),
      shell: options.shell ?? 'direct',
    },
    cwd: options.cwd,
    git: {
      commitSha: sha.ok ? sha.text.trim() : null,
      dirty: Boolean(dirty.text.trim()),
      ...(!sha.ok ? { error: 'Commit metadata unavailable.' } : {}),
    },
    diffs: [{ phase: 'before' as const, ...before }],
  };
  const sequence = options.outbox.begin(eventId, options.sessionId, initial);
  let outputBytes = 0;
  let truncatedBytes = 0;
  let ordinal = 0;
  let storageError: Error | undefined;
  const append = (stream: 'stdout' | 'stderr', text: string): void => {
    const kept = safePrefix(text, Math.max(0, OUTPUT_LIMIT - outputBytes));
    truncatedBytes += Buffer.byteLength(text, 'utf8') - Buffer.byteLength(kept, 'utf8');
    outputBytes += Buffer.byteLength(kept, 'utf8');
    // Keep draining both child streams after a cap or local write failure.
    if (!kept || storageError) return;
    if (ordinal >= 500) {
      truncatedBytes += Buffer.byteLength(kept, 'utf8');
      return;
    }
    try {
      let remaining = kept;
      while (remaining) {
        const chunk = safePrefix(remaining, TEXT_CHUNK_LIMIT);
        options.outbox.append(eventId, ordinal++, stream, chunk);
        remaining = remaining.slice(chunk.length);
      }
      (stream === 'stdout' ? process.stdout : process.stderr).write(kept);
    } catch (error) {
      storageError = error instanceof Error ? error : new Error('Local output persistence failed.');
    }
  };
  const stdout = new StreamRedactor((text) => append('stdout', text), [options.token]);
  const stderr = new StreamRedactor((text) => append('stderr', text), [options.token]);
  let interrupted = false;
  let outcome: {
    kind: 'completed' | 'spawn_failed' | 'interrupted';
    exitCode: number | null;
    signal: string | null;
    error?: { code: string; message: string };
  };
  try {
    const invocation = resolveInvocation(executable, options.command.slice(1), options.shell);
    initial.command.shell = invocation.shell;
    outcome = await new Promise((resolve) => {
      const childEnv = { ...process.env };
      for (const name of [
        'MEMVORA_LOCAL_TOKEN',
        'AI_API_KEY',
        'GITHUB_CLIENT_SECRET',
        'GITHUB_WEBHOOK_SECRET',
        'GITHUB_PRIVATE_KEY',
      ])
        delete childEnv[name];
      const child = spawn(invocation.executable, invocation.args, {
        cwd: options.cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const interrupt = (): void => {
        interrupted = true;
        if (process.platform === 'win32' && child.pid) {
          const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          terminator.once('error', () => child.kill());
          terminator.once('close', (code) => {
            if (code !== 0) child.kill();
          });
        } else child.kill();
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      let spawnError: string | undefined;
      child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
      child.once('error', (error) => {
        spawnError = redactText(error.message, [options.token]);
      });
      child.once('close', (exitCode, signal) => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
        stdout.end();
        stderr.end();
        resolve({
          kind: spawnError
            ? 'spawn_failed'
            : interrupted || signal !== null
              ? 'interrupted'
              : 'completed',
          exitCode: spawnError ? null : exitCode,
          signal,
          ...(spawnError
            ? { error: { code: 'SPAWN_FAILED', message: spawnError.slice(0, 1000) } }
            : {}),
        });
      });
    });
  } catch (error) {
    stdout.end();
    stderr.end();
    outcome = {
      kind: 'spawn_failed',
      exitCode: null,
      signal: null,
      error: {
        code: 'SPAWN_FAILED',
        message: redactText(error instanceof Error ? error.message : 'Unable to launch command.', [
          options.token,
        ]).slice(0, 1000),
      },
    };
  }
  const after = await snapshotDiff(options.cwd, options.token);
  truncatedBytes += stdout.suppressedBytes + stderr.suppressedBytes;
  const event = fitEventEnvelope({
    ...initial,
    sequence,
    endedAt: new Date().toISOString(),
    outcome,
    capture: {
      complete: !storageError && outcome.kind !== 'interrupted' && truncatedBytes === 0,
      truncatedBytes,
      redacted: true,
    },
    output: options.outbox.output(eventId),
    diffs: [...initial.diffs, { phase: 'after', ...after }],
  });
  options.outbox.finalize(eventId, event);
  if (storageError)
    throw new Error(
      'Local output persistence failed; captured evidence is incomplete. Inspect the outbox before retrying.',
    );
  if (outcome.error) console.error(outcome.error.message);
  console.error(
    `Captured event ${eventId}${event.capture.truncatedBytes ? ` (${event.capture.truncatedBytes} output bytes truncated)` : ''}.`,
  );
  return { eventId, exitCode: outcome.exitCode ?? (outcome.kind === 'interrupted' ? 130 : 127) };
}

export function recoverIncomplete(outbox: LocalOutbox): number {
  const rows = outbox.incomplete();
  let recovered = 0;
  for (const row of rows) {
    // Unknown legacy owners, EPERM, and reused live PIDs are deliberately left alone.
    // Recovery never guesses from age and never signals or kills a capture process.
    if (row.ownerPid === null || !Number.isInteger(row.ownerPid) || row.ownerPid <= 0) continue;
    try {
      process.kill(row.ownerPid, 0);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') continue;
    }
    outbox.finalize(
      row.eventId,
      fitEventEnvelope({
        ...row.initial,
        sequence: row.sequence,
        endedAt: new Date().toISOString(),
        outcome: { kind: 'incomplete', exitCode: null, signal: null },
        capture: { complete: false, truncatedBytes: 0, redacted: true },
        output: outbox.output(row.eventId),
      } as CapturedEvent),
    );
    recovered++;
  }
  return recovered;
}
