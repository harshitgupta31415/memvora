import Type from 'typebox';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, toolResult } from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('MCP API boundary', () => {
  it('uses an explicit token without resolving invalid data-directory configuration', async () => {
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'private-client-fixture-token-at-least-32-characters');
    vi.stubEnv('MEMVORA_DATA_DIR', 'invalid\u0000directory');
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await request('/example', Type.Object({}));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns a safe bounded credential-file failure without contacting the API', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memvora-mcp-credentials-'));
    const privateMarker = 'PRIVATE_CREDENTIAL_PATH_FIXTURE';
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', undefined);
    vi.stubEnv('MEMVORA_DATA_DIR', join(directory, privateMarker));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = await toolResult(() => request('/v1/me', Type.Object({})));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('credential is unavailable');
      expect(JSON.stringify(result)).not.toContain(privateMarker);
      expect(JSON.stringify(result)).not.toContain('ENOENT');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      const target = resolve(directory);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('memvora-mcp-credentials-')
      )
        throw new Error('Unexpected credential fixture cleanup target.');
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('refuses to transmit a local credential to a non-loopback origin', async () => {
    vi.stubEnv('MEMVORA_API_URL', 'https://example.com');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'private-local-fixture-token-at-least-32-chars');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(request('/v1/me', Type.Object({}))).rejects.toThrow('loopback');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('turns a denied API request into a bounded tool error without evidence', async () => {
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'private-local-fixture-token-at-least-32-chars');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ privateEvidence: 'must-not-be-returned' }), {
            status: 403,
          }),
      ),
    );
    const result = await toolResult(() => request('/v1/memories/private', Type.Object({})));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('must-not-be-returned');
    expect(JSON.stringify(result)).not.toContain('private-local-fixture-token');
  });

  it('uses redirect rejection and refuses an origin carrying credentials or query data', async () => {
    vi.stubEnv('MEMVORA_LOCAL_TOKEN', 'private-local-fixture-token-at-least-32-chars');
    vi.stubEnv('MEMVORA_API_URL', 'http://127.0.0.1:4000');
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await request('/example', Type.Object({}));
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
    vi.stubEnv('MEMVORA_API_URL', 'http://user:password@127.0.0.1:4000/?token=private#fragment');
    await expect(request('/example', Type.Object({}))).rejects.toThrow('plain loopback');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
