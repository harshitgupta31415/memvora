import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { captureCommand, FINAL_EVENT_JSON_LIMIT, fitEventEnvelope } from './capture.js';
import { LocalOutbox } from './local.js';

describe('explicit wrapper evidence', () => {
  it('rejects aggregate command metadata before allocating a capture', async () => {
    const outbox = new LocalOutbox(':memory:');
    try {
      await expect(
        captureCommand({
          cwd: process.cwd(),
          repositoryId: '11111111-1111-4111-8111-111111111111',
          sessionId: '22222222-2222-4222-8222-222222222222',
          outbox,
          token: 'fixture-not-a-real-credential',
          databasePath: ':memory:',
          command: [process.execPath, ...Array.from({ length: 20 }, () => '\\'.repeat(8192))],
        }),
      ).rejects.toThrow('128 KiB JSON limit');
      expect(outbox.counts()).toEqual({ pending: 0, incomplete: 0 });
    } finally {
      outbox.close();
    }
  });

  it('bounds escaped transport JSON and accounts for every shortened evidence byte', () => {
    const event: CapturedEvent = {
      eventId: '11111111-1111-4111-8111-111111111111',
      repositoryId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      sequence: 1,
      startedAt: '2026-10-21T10:00:00.000Z',
      endedAt: '2026-10-21T10:00:01.000Z',
      command: { executable: 'node', args: ['script.js'], shell: 'direct' },
      cwd: 'C:\\fixture',
      git: { commitSha: 'a'.repeat(40), afterCommitSha: 'b'.repeat(40), dirty: true },
      outcome: { kind: 'completed', exitCode: 0, signal: null },
      capture: { complete: true, truncatedBytes: 0, redacted: true },
      output: Array.from({ length: 16 }, (_value, ordinal) => ({
        stream: 'stdout',
        ordinal,
        text: '\u0001'.repeat(8192),
      })),
      diffs: [
        {
          phase: 'before',
          text: '\\'.repeat(32768),
          truncatedBytes: 0,
          baselineCommitSha: 'a'.repeat(40),
        },
        {
          phase: 'after',
          text: '😀'.repeat(8192),
          truncatedBytes: 0,
          baselineCommitSha: 'a'.repeat(40),
        },
      ],
    };
    const outputBytes = event.output.reduce(
      (sum, chunk) => sum + Buffer.byteLength(chunk.text, 'utf8'),
      0,
    );
    const diffBytes = event.diffs.reduce(
      (sum, diff) => sum + Buffer.byteLength(diff.text, 'utf8'),
      0,
    );
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeGreaterThan(
      FINAL_EVENT_JSON_LIMIT,
    );
    const bounded = fitEventEnvelope(event);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
      FINAL_EVENT_JSON_LIMIT,
    );
    expect(bounded.capture.complete).toBe(false);
    expect(bounded.capture.truncatedBytes).toBe(
      outputBytes -
        bounded.output.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, 'utf8'), 0),
    );
    expect(bounded.diffs.reduce((sum, diff) => sum + diff.truncatedBytes, 0)).toBe(
      diffBytes -
        bounded.diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff.text, 'utf8'), 0),
    );
    expect(bounded.command).toEqual({ executable: 'node', args: ['script.js'], shell: 'direct' });
    expect(bounded.outcome.exitCode).toBe(0);
    expect(bounded.git).toEqual({
      commitSha: 'a'.repeat(40),
      afterCommitSha: 'b'.repeat(40),
      dirty: true,
    });
    expect(bounded.diffs.map((diff) => diff.baselineCommitSha)).toEqual([
      'a'.repeat(40),
      'a'.repeat(40),
    ]);
    const outbox = new LocalOutbox(':memory:');
    try {
      outbox.begin(bounded.eventId, bounded.sessionId, {});
      outbox.finalize(bounded.eventId, bounded);
      expect(outbox.pending()).toHaveLength(1);
    } finally {
      outbox.close();
    }
  });

  it('preserves literal arguments and failed startup as separate durable attempts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-capture-'));
    const path = join(directory, 'outbox.sqlite');
    const outbox = new LocalOutbox(path);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const name of [
      'MEMVORA_LOCAL_TOKEN',
      'AI_API_KEY',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_PRIVATE_KEY',
    ])
      vi.stubEnv(name, 'fixture-server-secret-not-for-the-child');
    const shared = {
      cwd: directory,
      repositoryId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      outbox,
      token: 'test-local-credential-not-real',
      databasePath: path,
    };
    try {
      const first = await captureCommand({
        ...shared,
        command: [
          process.execPath,
          '-e',
          'console.log(process.argv[1]); console.error("TOKEN=privatefixture"); console.log(JSON.stringify(["MEMVORA_LOCAL_TOKEN","AI_API_KEY","GITHUB_CLIENT_SECRET","GITHUB_WEBHOOK_SECRET","GITHUB_PRIVATE_KEY"].map(name=>process.env[name]??null))); console.log("x".repeat(17000));',
          'literal & 100% "quoted"',
        ],
      });
      const second = await captureCommand({
        ...shared,
        command: ['memvora-intentionally-missing-executable-for-test'],
      });
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(127);
      const pending = outbox.pending();
      expect(pending).toHaveLength(2);
      const successful = pending.find((row) => row.eventId === first.eventId)!.payload;
      const missing = pending.find((row) => row.eventId === second.eventId)!.payload;
      expect(JSON.stringify(successful['output'])).toContain('literal & 100%');
      expect(JSON.stringify(successful['output'])).toContain('[null,null,null,null,null]');
      expect(JSON.stringify(successful)).not.toContain('privatefixture');
      expect((successful['capture'] as { complete: boolean }).complete).toBe(false);
      expect(
        (successful['capture'] as { truncatedBytes: number }).truncatedBytes,
      ).toBeGreaterThanOrEqual(17000);
      expect((missing['outcome'] as { kind: string }).kind).toBe('spawn_failed');
      expect((missing['outcome'] as { exitCode: number | null }).exitCode).toBeNull();
      expect(successful['sequence']).toBe(1);
      expect(missing['sequence']).toBe(2);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      vi.unstubAllEnvs();
      outbox.close();
      const cleanup = resolve(directory);
      if (
        dirname(cleanup) !== resolve(tmpdir()) ||
        !basename(cleanup).startsWith('memvora-capture-')
      )
        throw new Error('Unexpected test cleanup target.');
      rmSync(cleanup, { recursive: true, force: true });
    }
  }, 20_000);
});
