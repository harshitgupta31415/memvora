import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handoverFormat,
  readSessionHandoverDownload,
  writeSessionHandoverFile,
  HANDOVER_DOWNLOAD_BYTE_LIMIT,
} from './session-export.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const token = 'private-local-handover-test-token-at-least-32-characters';
const download = () => ({
  format: 'markdown',
  filename: `memvora-handover-${sessionId}.md`,
  mediaType: 'text/markdown',
  content: '# Explicit handover fixture\n',
});

function removeFixture(directory: string) {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('memvora-export-'))
    throw new Error('Unexpected cleanup target.');
  rmSync(target, { recursive: true, force: true });
}

afterEach(() => vi.unstubAllGlobals());

describe('CLI private handover export', () => {
  it('validates format, exact download filename, media type and report shape before output', async () => {
    expect(handoverFormat()).toBe('markdown');
    expect(() => handoverFormat('html')).toThrow('json or');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(download())));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      readSessionHandoverDownload('http://127.0.0.1:4000', token, sessionId, 'markdown'),
    ).resolves.toEqual(download());
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:4000/v1/sessions/${sessionId}/handover/download?format=markdown`,
    );
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    for (const altered of [
      { ...download(), filename: '../escape.md' },
      { ...download(), mediaType: 'text/html' },
      { ...download(), format: 'json' },
    ]) {
      fetcher.mockImplementation(async () => new Response(JSON.stringify(altered)));
      await expect(
        readSessionHandoverDownload('http://127.0.0.1:4000', token, sessionId, 'markdown'),
      ).rejects.toThrow('contract');
    }
    fetcher.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            format: 'json',
            filename: `memvora-handover-${sessionId}.json`,
            mediaType: 'application/json',
            content: '{}',
          }),
        ),
    );
    await expect(
      readSessionHandoverDownload('http://127.0.0.1:4000', token, sessionId, 'json'),
    ).rejects.toThrow('shared report contract');
  });

  it('creates files exclusively, leaves existing files/symlinks intact and counts UTF-8 bytes before creation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-export-'));
    try {
      const path = join(directory, 'report.md');
      writeSessionHandoverFile(path, download().content);
      expect(readFileSync(path, 'utf8')).toBe(download().content);
      expect(() => writeSessionHandoverFile(path, 'replacement')).toThrow('never overwritten');
      expect(readFileSync(path, 'utf8')).toBe(download().content);
      const target = join(directory, 'target');
      mkdirSync(target);
      writeFileSync(join(target, 'keep.txt'), 'keep');
      const link = join(directory, 'link');
      symlinkSync(target, link, 'junction');
      expect(() => writeSessionHandoverFile(link, 'replacement')).toThrow();
      expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
      const excessive = join(directory, 'too-large.md');
      expect(() =>
        writeSessionHandoverFile(
          excessive,
          '界'.repeat(Math.floor(HANDOVER_DOWNLOAD_BYTE_LIMIT / 3) + 1),
        ),
      ).toThrow('byte limit');
      expect(existsSync(excessive)).toBe(false);
    } finally {
      removeFixture(directory);
    }
  });
});
