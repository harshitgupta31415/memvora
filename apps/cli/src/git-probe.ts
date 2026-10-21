import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export type GitProbeFailure = 'not_repository' | 'unavailable' | 'timeout' | 'failed';
export type GitProbeResult = {
  text: string;
  truncatedBytes: number;
  ok: boolean;
  /** Fixed classification only. Raw Git diagnostics are never returned or persisted. */
  failure?: GitProbeFailure;
};

/** Never let the Windows executable search consult the captured repository's cwd. */
function gitExecutable(): string | undefined {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH');
  for (const entry of (key ? (process.env[key] ?? '') : '').split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/u, '$1');
    if (
      !directory ||
      !isAbsolute(directory) ||
      (process.platform === 'win32' && /^[\\/]{2}/u.test(directory))
    )
      continue;
    const candidate = resolve(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // An unavailable PATH entry cannot widen discovery to cwd or a relative directory.
    }
  }
  return undefined;
}

function killRoot(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* Already gone or unavailable to this process. */
    }
  }
}

/** Signal only a group/root created by this invocation; never enumerate unrelated processes. */
async function terminateOwnedTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) {
    killRoot(child);
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      killRoot(child);
    }
    return;
  }
  // Do not target an exited root's PID, which may already have been reused.
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    let terminator: ChildProcess | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killRoot(child);
      done();
    };
    const timer = setTimeout(() => {
      if (terminator) killRoot(terminator);
      finish();
    }, 5_500);
    try {
      const configured = process.env['SystemRoot'] ?? process.env['WINDIR'];
      const systemRoot = configured && isAbsolute(configured) ? configured : 'C:\\Windows';
      terminator = execFile(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        {
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 16 * 1024,
        },
        finish,
      );
    } catch {
      finish();
    }
  });
}

const secretEnvironment = new Set([
  'MEMVORA_LOCAL_TOKEN',
  'AI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_PRIVATE_KEY_PATH',
]);

/** cwd determines the repository. Preserve an explicit discovery ceiling, never a redirect. */
function probeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase();
    if (
      secretEnvironment.has(upper) ||
      (upper.startsWith('GIT_') && upper !== 'GIT_CEILING_DIRECTORIES')
    )
      delete environment[name];
  }
  return {
    ...environment,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
  };
}

export async function gitText(
  cwd: string,
  args: string[],
  limit = 32 * 1024,
  options: { timeoutMs?: number } = {},
): Promise<GitProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 10_000)
    return { text: '', truncatedBytes: 0, ok: false, failure: 'failed' };
  const executable = gitExecutable();
  if (!executable) return { text: '', truncatedBytes: 0, ok: false, failure: 'unavailable' };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        executable,
        ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
        {
          cwd,
          env: probeEnvironment(),
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch {
      resolve({ text: '', truncatedBytes: 0, ok: false, failure: 'failed' });
      return;
    }
    const chunks: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let diagnosticBytes = 0;
    let stored = 0;
    let truncatedBytes = 0;
    let failure: GitProbeFailure | undefined;
    let closed = false;
    let settled = false;
    let exitCode: number | null = null;
    let cleanup: Promise<void> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      if (exitCode !== 0 || failure) {
        const message = Buffer.concat(diagnostics).toString('utf8');
        failure ??= /^fatal: not a git repository(?:[ :\r\n(]|$)/u.test(message)
          ? 'not_repository'
          : 'failed';
        resolve({ text: '', truncatedBytes: 0, ok: false, failure });
      } else resolve({ text: Buffer.concat(chunks).toString('utf8'), truncatedBytes, ok: true });
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      const available = Math.max(0, limit - stored);
      if (available) chunks.push(chunk.subarray(0, available));
      stored += Math.min(available, chunk.length);
      truncatedBytes += Math.max(0, chunk.length - available);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const available = Math.max(0, 4096 - diagnosticBytes);
      if (available) diagnostics.push(chunk.subarray(0, available));
      diagnosticBytes += Math.min(available, chunk.length);
    });
    const timer = setTimeout(() => {
      failure = 'timeout';
      cleanup = terminateOwnedTree(child);
      void cleanup.then(() => {
        if (closed) {
          finish();
          return;
        }
        closeTimer = setTimeout(() => {
          killRoot(child);
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish();
        }, 1_000);
      });
    }, timeoutMs);
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure ??= error.code === 'ENOENT' ? 'unavailable' : 'failed';
    });
    // A filter may keep pipes open after its root dies. Tree cleanup precedes a bounded pipe grace.
    child.once('close', (code) => {
      closed = true;
      exitCode = code;
      if (cleanup) void cleanup.then(finish);
      else finish();
    });
  });
}
