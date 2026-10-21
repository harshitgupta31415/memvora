import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { basename, isAbsolute } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn, execFile } = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn, execFile }));
import { gitText } from './git-probe.js';

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
    pid: 555555,
    exitCode: null,
    signalCode: null,
  });
  spawn.mockReturnValueOnce(process);
  return process;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  spawn.mockReset();
  execFile.mockReset();
});

describe('bounded local Git probes', () => {
  it('removes credentials and repository redirection while disabling pager, optional locks and fsmonitor', async () => {
    for (const name of [
      'MEMVORA_LOCAL_TOKEN',
      'AI_API_KEY',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_PRIVATE_KEY',
      'GITHUB_PRIVATE_KEY_PATH',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_CONFIG_COUNT',
      'GIT_EXTERNAL_DIFF',
    ])
      vi.stubEnv(name, 'PrivateProbeEnvironmentFixture');
    vi.stubEnv('GIT_CEILING_DIRECTORIES', '/safe/discovery/boundary');
    const c = child();
    const result = gitText('/working/tree', ['status', '--porcelain'], 1024);
    const invocation = spawn.mock.calls[0]!;
    expect(isAbsolute(invocation[0])).toBe(true);
    expect(basename(invocation[0]).toLowerCase()).toBe(
      process.platform === 'win32' ? 'git.exe' : 'git',
    );
    expect(invocation[1]).toEqual([
      '--no-pager',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain',
    ]);
    expect(invocation[2]).toMatchObject({ cwd: '/working/tree', windowsHide: true });
    const environment = invocation[2].env as NodeJS.ProcessEnv;
    expect(JSON.stringify(environment)).not.toContain('PrivateProbeEnvironmentFixture');
    expect(environment['GIT_CEILING_DIRECTORIES']).toBe('/safe/discovery/boundary');
    expect(environment['LC_ALL']).toBe('C');
    expect(environment['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(environment['GIT_NO_LAZY_FETCH']).toBe('1');
    c.emit('close', 0);
    expect(await result).toEqual({ ok: true, text: '', truncatedBytes: 0 });
  });

  it('keeps successful stdout bounded and drains diagnostics without exposing them', async () => {
    const c = child();
    const result = gitText('.', ['diff'], 8);
    c.stdout.write(Buffer.from('0123456789ABCDEF'));
    c.stderr.write(Buffer.from('PrivateDiagnosticFixture'.repeat(1000)));
    c.emit('close', 0);
    expect(await result).toEqual({ ok: true, text: '01234567', truncatedBytes: 8 });
  });

  it('distinguishes no repository from access failures and discards partial stdout on either failure', async () => {
    for (const [diagnostic, failure] of [
      ['fatal: not a git repository (or any of the parent directories): .git', 'not_repository'],
      ['fatal: detected dubious ownership in repository PrivateDiagnosticFixture', 'failed'],
    ]) {
      const c = child();
      const result = gitText('.', ['status']);
      c.stdout.write(Buffer.from('PrivatePartialDiffFixture'));
      c.stderr.write(Buffer.from(diagnostic!));
      c.emit('close', 128);
      expect(await result).toEqual({ ok: false, text: '', truncatedBytes: 0, failure });
    }
  });

  it('reports a missing executable safely after close', async () => {
    const c = child();
    const result = gitText('.', ['rev-parse', 'HEAD']);
    c.emit('error', Object.assign(new Error('PrivateSpawnDiagnosticFixture'), { code: 'ENOENT' }));
    c.emit('close', -2);
    expect(await result).toEqual({
      ok: false,
      text: '',
      truncatedBytes: 0,
      failure: 'unavailable',
    });
  });

  it('kills a timed-out owned Git process and awaits its close before returning a safe failure', async () => {
    vi.useFakeTimers();
    const killGroup = vi.spyOn(process, 'kill').mockImplementation(() => true);
    execFile.mockImplementation((_path, _args, _options, callback) => {
      void Promise.resolve().then(() => callback(null, '', ''));
      return { kill: vi.fn(), exitCode: null, signalCode: null };
    });
    const c = child();
    let settled = false;
    const result = gitText('.', ['status']).then((value) => {
      settled = true;
      return value;
    });
    c.stdout.write(Buffer.from('PartialTimedOutDiff'));
    await vi.advanceTimersByTimeAsync(10_000);
    if (process.platform === 'win32') {
      expect(execFile.mock.calls[0]?.[1]).toEqual(['/PID', String(c.pid), '/T', '/F']);
      expect(execFile.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 5000 });
      expect(isAbsolute(execFile.mock.calls[0]?.[0])).toBe(true);
      expect(c.kill).toHaveBeenCalledWith('SIGKILL');
    } else {
      expect(killGroup).toHaveBeenCalledWith(-c.pid, 'SIGKILL');
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true });
    }
    expect(settled).toBe(false);
    c.emit('close', null);
    expect(await result).toEqual({ ok: false, text: '', truncatedBytes: 0, failure: 'timeout' });
  });

  it('bounds the pipe-close grace even when a timed-out descendant retains a pipe', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    execFile.mockImplementation((_path, _args, _options, callback) => {
      void Promise.resolve().then(() => callback(null, '', ''));
      return { kill: vi.fn(), exitCode: null, signalCode: null };
    });
    const c = child();
    const result = gitText('.', ['status'], 1024, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(1025);
    expect(await result).toEqual({ ok: false, text: '', truncatedBytes: 0, failure: 'timeout' });
    expect(c.stdout.destroyed).toBe(true);
    expect(c.stderr.destroyed).toBe(true);
    expect(c.unref).toHaveBeenCalled();
  });

  it('does not search cwd, relative PATH entries or an empty PATH for a Git executable', async () => {
    vi.stubEnv('PATH', process.platform === 'win32' ? ';.;relative\\bin' : ':.:relative/bin');
    expect(await gitText('.', ['status'])).toEqual({
      ok: false,
      text: '',
      truncatedBytes: 0,
      failure: 'unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
