import { fork } from 'node:child_process';
import { once } from 'node:events';

/** Keep the deadline outside synchronous SQLite work in the filesystem operator. */
export async function runBackupWorker(
  modulePath,
  args,
  { deadlineMs = 120_000, maxOutputBytes = 65_536 } = {},
) {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 120_000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 65_536
  )
    throw new Error('Invalid backup worker limits.');
  const child = fork(modulePath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  let bytes = 0;
  let timedOut = false;
  let interrupted = false;
  let overflow = false;
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const interrupt = () => {
    interrupted = true;
    kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, deadlineMs);
  const collect = (channel) => (chunk) => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxOutputBytes) {
      overflow = true;
      kill();
      return;
    }
    if (channel === 'stdout') stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.setEncoding('utf8').on('data', collect('stdout'));
  child.stderr.setEncoding('utf8').on('data', collect('stderr'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  process.once('exit', kill);
  try {
    const [code, signal] = await once(child, 'close');
    return { stdout, stderr, code, signal, timedOut, interrupted, overflow };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('exit', kill);
    kill();
  }
}
