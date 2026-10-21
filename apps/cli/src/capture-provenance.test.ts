import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { captureCommand, gitText } from './capture.js';
import { LocalOutbox } from './local.js';

const temporaryRoot = realpathSync(tmpdir());
const folders: string[] = [];
const outboxes: LocalOutbox[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const outbox of outboxes.splice(0)) outbox.close();
  for (const folder of folders.splice(0)) {
    const target = realpathSync(folder);
    if (
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith('memvora-git-capture-') ||
      !target.startsWith(join(temporaryRoot, 'memvora-git-capture-'))
    )
      throw new Error('Unsafe Git capture fixture cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
const success = (text = '') => ({ ok: true, text, truncatedBytes: 0 });
function fixture() {
  const cwd = mkdtempSync(join(temporaryRoot, 'memvora-git-capture-'));
  folders.push(cwd);
  const outbox = new LocalOutbox(':memory:');
  outboxes.push(outbox);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const options = {
    cwd,
    repositoryId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    outbox,
    token: 'fixture-not-a-real-credential',
    databasePath: ':memory:',
    command: [process.execPath, '-e', 'console.log("observed command output");process.exit(7)'],
  };
  const event = () => outbox.pending().at(-1)!.payload as unknown as CapturedEvent;
  return { cwd, outbox, options, event };
}
function realGit(cwd: string) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment))
    if (name.toUpperCase().startsWith('GIT_')) delete environment[name];
  environment['GIT_CONFIG_NOSYSTEM'] = '1';
  environment['GIT_CONFIG_GLOBAL'] = join(cwd, 'nonexistent-global-config');
  return (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: environment,
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString('utf8')
      .trim();
}
function commitArguments(cwd: string): string[] {
  return [
    '-c',
    'user.name=harshitgupta31415',
    '-c',
    'user.email=harshitgupta3.1415@gmail.com',
    '-c',
    'commit.gpgSign=false',
    '-c',
    `core.hooksPath=${join(cwd, 'nonexistent-hooks')}`,
    'commit',
    '-qm',
    'Synthetic provenance fixture',
  ];
}
function commitFixture(run: (...args: string[]) => string, cwd: string) {
  run(...commitArguments(cwd));
}
function injected(
  fail?: 'HEAD' | 'after HEAD' | 'status' | 'before' | 'after',
  kind = 'failed' as 'failed' | 'timeout' | 'unavailable' | 'not_repository',
) {
  let diffs = 0;
  let heads = 0;
  return vi.fn<typeof gitText>(async (_cwd, args) => {
    const phase =
      args[0] === 'rev-parse'
        ? ++heads === 1
          ? 'HEAD'
          : 'after HEAD'
        : args[0] === 'status'
          ? 'status'
          : ++diffs === 1
            ? 'before'
            : 'after';
    if (phase === fail)
      return {
        ok: false,
        text: 'PrivateFailedGitPartialFixture',
        truncatedBytes: 200,
        failure: kind,
      };
    return success(
      phase === 'HEAD' || phase === 'after HEAD'
        ? 'a'.repeat(40)
        : phase === 'status'
          ? ''
          : `${phase} synthetic diff`,
    );
  });
}

describe('capture Git provenance', () => {
  it('preserves successful clean status and the two bounded diff phases', async () => {
    const f = fixture();
    const git = injected();
    expect((await captureCommand(f.options, { git })).exitCode).toBe(7);
    expect(f.event().git).toEqual({
      commitSha: 'a'.repeat(40),
      afterCommitSha: 'a'.repeat(40),
      dirty: false,
    });
    expect(f.event().capture.complete).toBe(true);
    expect(f.event().diffs.map((diff) => diff.phase)).toEqual(['before', 'after']);
    for (const call of git.mock.calls.filter((call) => call[1][0] === 'diff')) {
      expect(call[1]).toContain('--no-ext-diff');
      expect(call[1]).toContain('--no-textconv');
      expect(call[1][1]).toBe('a'.repeat(40));
      expect(call[1]).not.toContain('HEAD');
      expect(call[2]).toBe(32 * 1024);
    }
    expect(f.event().diffs.every((diff) => diff.baselineCommitSha === 'a'.repeat(40))).toBe(true);
  });

  it.each([40, 64])(
    'pins both diffs to the validated %i-character start commit even if HEAD moves before the first diff',
    async (length) => {
      const f = fixture();
      const startingCommit = 'a'.repeat(length);
      const laterCommit = 'b'.repeat(length);
      let observedHead = startingCommit;
      const git = vi.fn<typeof gitText>(async (_cwd, args) => {
        if (args[0] === 'rev-parse') return success(observedHead);
        if (args[0] === 'status') {
          observedHead = laterCommit;
          return success();
        }
        return success(`captured snapshot relative to ${args[1]}`);
      });
      const begin = vi.spyOn(f.outbox, 'begin');
      expect((await captureCommand(f.options, { git })).exitCode).toBe(7);
      expect(f.event().git).toEqual({
        commitSha: startingCommit,
        afterCommitSha: laterCommit,
        dirty: false,
      });
      expect(f.event().diffs).toHaveLength(2);
      expect(f.event().diffs.every((diff) => diff.baselineCommitSha === startingCommit)).toBe(true);
      expect(
        git.mock.calls.filter((call) => call[1][0] === 'diff').map((call) => call[1][1]),
      ).toEqual([startingCommit, startingCommit]);
      expect(begin.mock.calls[0]?.[2]).not.toHaveProperty('git.afterCommitSha');
      expect(f.event().capture.complete).toBe(true);
    },
  );

  it('never replaces an unresolved start baseline with a later valid HEAD', async () => {
    const f = fixture();
    const git = injected('HEAD');
    expect((await captureCommand(f.options, { git })).exitCode).toBe(7);
    expect(f.event().git).toEqual({
      commitSha: null,
      afterCommitSha: 'a'.repeat(40),
      dirty: false,
      error: 'Git evidence unavailable: HEAD (failed).',
    });
    expect(f.event().diffs).toEqual([]);
    expect(f.event().capture.complete).toBe(false);
    expect(git.mock.calls.some((call) => call[1][0] === 'diff')).toBe(false);
  });

  it.each(['not-a-commit', 'b'.repeat(41), 'b'.repeat(63)])(
    'retains pinned snapshots when the after HEAD output is malformed (%s)',
    async (afterHead) => {
      const f = fixture();
      let heads = 0;
      const git = vi.fn<typeof gitText>(async (_cwd, args) =>
        success(args[0] === 'rev-parse' ? (++heads === 1 ? 'a'.repeat(40) : afterHead) : ''),
      );
      expect((await captureCommand(f.options, { git })).exitCode).toBe(7);
      expect(f.event().git).toEqual({
        commitSha: 'a'.repeat(40),
        afterCommitSha: null,
        dirty: false,
        error: 'Git evidence unavailable: after HEAD (failed).',
      });
      expect(f.event().diffs.map((diff) => diff.baselineCommitSha)).toEqual([
        'a'.repeat(40),
        'a'.repeat(40),
      ]);
      expect(f.event().capture.complete).toBe(false);
    },
  );

  it('rejects a truncated after HEAD even when its retained text looks like a full SHA', async () => {
    const f = fixture();
    let heads = 0;
    const git = vi.fn<typeof gitText>(async (_cwd, args) =>
      args[0] === 'rev-parse' && ++heads === 2
        ? { ok: true, text: 'b'.repeat(40), truncatedBytes: 1 }
        : success(args[0] === 'rev-parse' ? 'a'.repeat(40) : ''),
    );
    await captureCommand(f.options, { git });
    expect(f.event().git.afterCommitSha).toBeNull();
    expect(f.event().git.error).toContain('after HEAD (failed)');
    expect(f.event().diffs).toHaveLength(2);
    expect(f.event().capture.complete).toBe(false);
  });

  it.each(['status', 'before', 'after', 'after HEAD'] as const)(
    'records a %s failure without altering execution or persisting partial diagnostics',
    async (phase) => {
      const f = fixture();
      const result = await captureCommand(f.options, { git: injected(phase) });
      expect(result.exitCode).toBe(7);
      const event = f.event();
      expect(event.git.commitSha).toBe('a'.repeat(40));
      expect(event.git.error).toContain(
        phase === 'status' || phase === 'after HEAD'
          ? `${phase} (failed)`
          : `${phase} diff (failed)`,
      );
      expect(event.capture.complete).toBe(false);
      expect(event.output.map((chunk) => chunk.text).join('')).toContain('observed command output');
      if (phase === 'before' || phase === 'after')
        expect(event.diffs.map((diff) => diff.phase)).toEqual([
          phase === 'before' ? 'after' : 'before',
        ]);
      else expect(event.diffs.map((diff) => diff.phase)).toEqual(['before', 'after']);
      expect(event.git.afterCommitSha).toBe(phase === 'after HEAD' ? null : 'a'.repeat(40));
      expect(JSON.stringify(event)).not.toContain('PrivateFailedGitPartialFixture');
      expect(event.outcome).toMatchObject({ kind: 'completed', exitCode: 7 });
    },
  );

  it.each(['unavailable', 'timeout', 'not_repository'] as const)(
    'preserves a safe %s classification and still executes the command',
    async (failure) => {
      const f = fixture();
      const git = vi.fn<typeof gitText>(async () => ({
        ok: false,
        text: 'PrivateProbeDiagnosticFixture',
        truncatedBytes: 0,
        failure,
      }));
      expect((await captureCommand(f.options, { git })).exitCode).toBe(7);
      expect(f.event().git).toEqual({
        commitSha: null,
        afterCommitSha: null,
        dirty: false,
        error: `Git evidence unavailable: HEAD (${failure}); status (${failure}); after HEAD (${failure}).`,
      });
      expect(f.event().diffs).toEqual([]);
      expect(f.event().capture.complete).toBe(false);
      expect(JSON.stringify(f.event())).not.toContain('PrivateProbeDiagnosticFixture');
      expect(git.mock.calls.map((call) => call[1][0])).toEqual([
        'rev-parse',
        'status',
        'rev-parse',
      ]);
    },
  );

  it('contains unexpected probe rejection and malformed successful HEAD output without losing the attempt', async () => {
    const f = fixture();
    const git = vi.fn<typeof gitText>(async (_cwd, args) => {
      if (args[0] === 'status') throw new Error('PrivateUnexpectedGitFailure');
      return success(args[0] === 'rev-parse' ? 'not-a-commit' : '');
    });
    expect((await captureCommand(f.options, { git })).exitCode).toBe(7);
    expect(f.event().git.commitSha).toBeNull();
    expect(f.event().git.afterCommitSha).toBeNull();
    expect(f.event().git.error).toContain('HEAD (failed); status (failed)');
    expect(f.event().capture.complete).toBe(false);
    expect(JSON.stringify(f.event())).not.toContain('PrivateUnexpectedGitFailure');
    expect(git.mock.calls.some((call) => call[1][0] === 'diff')).toBe(false);
  });

  it('captures real clean/dirty Git state while rejecting environment redirection and excluding sensitive/untracked contents', async () => {
    const f = fixture();
    const run = realGit(f.cwd);
    run('init', '-q');
    expect((await captureCommand(f.options)).exitCode).toBe(7);
    expect(f.event().git.commitSha).toBeNull();
    expect(f.event().git.error).toContain('HEAD (failed)');
    expect(f.event().diffs).toEqual([]);
    expect(f.event().capture.complete).toBe(false);
    writeFileSync(join(f.cwd, 'source.txt'), 'original synthetic source\n');
    const names = [
      '.env.fixture',
      'fixture.pem',
      'fixture.key',
      'credentials-fixture.json',
      '.npmrc',
      '.pypirc',
      '.netrc',
      'id_rsa.fixture',
      'id_ed25519.fixture',
      '.memvora/private.txt',
    ];
    const excluded = names.flatMap((name) => [name.toUpperCase(), `nested/${name}`]);
    for (const name of excluded) {
      mkdirSync(dirname(join(f.cwd, name)), { recursive: true });
      writeFileSync(join(f.cwd, name), 'Original synthetic excluded contents\n');
    }
    writeFileSync(join(f.cwd, '.gitattributes'), 'source.txt diff=memvora-fixture\n');
    run('add', '-f', '--', 'source.txt', '.gitattributes', ...excluded);
    commitFixture(run, f.cwd);
    // Without --no-textconv the dirty capture invokes this nonexistent converter and fails.
    run('config', 'diff.memvora-fixture.textconv', 'memvora-intentionally-missing-textconv-helper');
    const sha = run('rev-parse', 'HEAD');
    vi.stubEnv('GIT_DIR', join(f.cwd, 'nonexistent-foreign-git-dir'));
    vi.stubEnv('GIT_WORK_TREE', dirname(f.cwd));
    vi.stubEnv('GIT_INDEX_FILE', join(f.cwd, 'nonexistent-foreign-index'));
    vi.stubEnv('GIT_CEILING_DIRECTORIES', temporaryRoot);
    await captureCommand(f.options);
    expect(f.event().git).toEqual({ commitSha: sha, afterCommitSha: sha, dirty: false });
    expect(f.event().diffs.every((diff) => diff.text === '')).toBe(true);
    expect(f.event().capture.complete).toBe(true);
    writeFileSync(join(f.cwd, 'source.txt'), 'visible tracked modification\n');
    for (const [index, name] of excluded.entries())
      writeFileSync(join(f.cwd, name), `PrivateExcludedFileFixture${index}\n`);
    writeFileSync(join(f.cwd, 'untracked.txt'), 'PrivateUntrackedContentFixture\n');
    // Bare Windows spawn would consult cwd and try these invalid repository-controlled binaries.
    writeFileSync(join(f.cwd, 'git.exe'), 'PrivateRepositoryGitShadowFixture');
    writeFileSync(join(f.cwd, 'git.com'), 'PrivateRepositoryGitShadowFixture');
    await captureCommand(f.options);
    expect(f.event().git).toEqual({ commitSha: sha, afterCommitSha: sha, dirty: true });
    expect(f.event().capture.complete).toBe(true);
    const diffs = f
      .event()
      .diffs.map((diff) => diff.text)
      .join('\n');
    expect(diffs).toContain('visible tracked modification');
    for (const secret of [
      'PrivateExcludedFileFixture',
      'PrivateUntrackedContentFixture',
      'PrivateRepositoryGitShadowFixture',
    ])
      expect(diffs).not.toContain(secret);
  }, 20_000);

  it('keeps an explicit common baseline across pre-existing edits, staging, commit, reset and checkout', async () => {
    const f = fixture();
    const run = realGit(f.cwd);
    run('init', '-q');
    writeFileSync(join(f.cwd, 'source.txt'), 'original source\n');
    writeFileSync(join(f.cwd, 'second.txt'), 'original second source\n');
    run('add', '--', 'source.txt', 'second.txt');
    commitFixture(run, f.cwd);
    const startingCommit = run('rev-parse', 'HEAD');
    writeFileSync(join(f.cwd, 'source.txt'), 'pre-existing tracked edit\n');

    await captureCommand(f.options);
    expect(f.event().git).toEqual({
      commitSha: startingCommit,
      afterCommitSha: startingCommit,
      dirty: true,
    });
    expect(f.event().diffs[0]?.text).toContain('pre-existing tracked edit');
    expect(f.event().diffs[1]?.text).toBe(f.event().diffs[0]?.text);

    await captureCommand({
      ...f.options,
      command: [
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync("second.txt", "new tracked interval edit\\n")',
      ],
    });
    expect(f.event().diffs[0]?.text).not.toContain('new tracked interval edit');
    expect(f.event().diffs[1]?.text).toContain('new tracked interval edit');
    expect(f.event().diffs[1]?.text).toContain('pre-existing tracked edit');

    expect(
      (
        await captureCommand({
          ...f.options,
          command: ['git', 'add', '--', 'source.txt', 'second.txt'],
        })
      ).exitCode,
    ).toBe(0);
    expect(run('diff', '--cached', '--', 'source.txt')).toContain('pre-existing tracked edit');
    expect(f.event().diffs[0]?.text).toBe(f.event().diffs[1]?.text);

    expect(
      (await captureCommand({ ...f.options, command: ['git', ...commitArguments(f.cwd)] }))
        .exitCode,
    ).toBe(0);
    const committed = f.event();
    const laterCommit = run('rev-parse', 'HEAD');
    expect(laterCommit).not.toBe(startingCommit);
    expect(committed.git).toEqual({
      commitSha: startingCommit,
      afterCommitSha: laterCommit,
      dirty: true,
    });
    // Moving HEAD does not erase the after snapshot's interval evidence.
    expect(run('diff', 'HEAD', '--', 'source.txt', 'second.txt')).toBe('');
    expect(committed.diffs[0]?.text).toBe(committed.diffs[1]?.text);
    expect(committed.diffs[1]?.text).toContain('new tracked interval edit');
    expect(committed.diffs.every((diff) => diff.baselineCommitSha === startingCommit)).toBe(true);

    expect(
      (
        await captureCommand({
          ...f.options,
          command: ['git', 'reset', '--hard', startingCommit],
        })
      ).exitCode,
    ).toBe(0);
    expect(f.event().git).toEqual({
      commitSha: laterCommit,
      afterCommitSha: startingCommit,
      dirty: false,
    });
    expect(f.event().diffs[0]?.text).toBe('');
    expect(f.event().diffs[1]?.text).toContain('-new tracked interval edit');
    expect(f.event().diffs.every((diff) => diff.baselineCommitSha === laterCommit)).toBe(true);

    expect(
      (
        await captureCommand({
          ...f.options,
          command: ['git', 'checkout', '--detach', laterCommit],
        })
      ).exitCode,
    ).toBe(0);
    expect(f.event().git).toEqual({
      commitSha: startingCommit,
      afterCommitSha: laterCommit,
      dirty: false,
    });
    expect(f.event().diffs[0]?.text).toBe('');
    expect(f.event().diffs[1]?.text).toContain('+new tracked interval edit');
    expect(f.event().diffs.every((diff) => diff.baselineCommitSha === startingCommit)).toBe(true);
    expect(f.event().capture.complete).toBe(true);
  }, 45_000);

  it('times out a real idle clean-filter tree without leaving the filter or its pipe-holding descendant running', async () => {
    const f = fixture();
    const run = realGit(f.cwd);
    run('init', '-q');
    writeFileSync(join(f.cwd, 'source.txt'), 'original synthetic source\n');
    run('add', '--', 'source.txt');
    commitFixture(run, f.cwd);
    const marker = join(f.cwd, 'owned-filter-pids.json');
    const script = join(f.cwd, 'idle-filter.cjs');
    writeFileSync(
      script,
      `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)'],{windowsHide:true,stdio:['ignore','inherit','inherit']});writeFileSync(${JSON.stringify(marker)},JSON.stringify({root:process.pid,child:child.pid}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
    );
    const quote = (value: string) => `"${value.replaceAll('\\', '/')}"`;
    run('config', 'filter.memvora-idle.clean', `${quote(process.execPath)} ${quote(script)}`);
    run('config', 'filter.memvora-idle.required', 'true');
    writeFileSync(join(f.cwd, '.gitattributes'), 'source.txt filter=memvora-idle\n');
    writeFileSync(
      join(f.cwd, 'source.txt'),
      'modified synthetic source that requires clean conversion\n',
    );
    let ids: number[] = [];
    const running = (pid: number) => {
      try {
        process.kill(pid, 0);
        // A terminated process awaiting adoption/reaping is not a running filter.
        if (
          process.platform === 'linux' &&
          readFileSync(`/proc/${pid}/stat`, 'utf8').match(/\) Z /u)
        )
          return false;
        return true;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
          return false;
        return true;
      }
    };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = Date.now();
      const result = await Promise.race([
        gitText(
          f.cwd,
          ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--', 'source.txt'],
          32768,
          { timeoutMs: 1500 },
        ),
        new Promise<never>((_done, reject) => {
          watchdog = setTimeout(
            () => reject(new Error('The owned Git filter cleanup exceeded its test deadline.')),
            9000,
          );
        }),
      ]);
      expect(result).toEqual({ ok: false, text: '', truncatedBytes: 0, failure: 'timeout' });
      expect(Date.now() - started).toBeLessThan(9000);
      expect(existsSync(marker)).toBe(true);
      const pids = JSON.parse(readFileSync(marker, 'utf8')) as { root: number; child: number };
      ids = [pids.root, pids.child];
      expect(ids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid)).toBe(
        true,
      );
      const deadline = Date.now() + 2000;
      while (ids.some(running) && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 25));
      expect(ids.filter(running)).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      if (!ids.length && existsSync(marker)) {
        const pids = JSON.parse(readFileSync(marker, 'utf8')) as { root: number; child: number };
        ids = [pids.root, pids.child];
      }
      for (const pid of ids) {
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !running(pid))
          continue;
        try {
          if (process.platform === 'win32')
            execFileSync(
              join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
              ['/PID', String(pid), '/T', '/F'],
              { windowsHide: true, timeout: 2000, stdio: 'ignore' },
            );
          else process.kill(pid, 'SIGKILL');
        } catch {
          /* The owned synthetic helper may already have exited. */
        }
      }
    }
  }, 15_000);
});
