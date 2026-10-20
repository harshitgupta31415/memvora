import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedEvent } from '@memvora/contracts';
import { createEnricher } from './index.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});

async function provider(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test provider did not bind.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'transport-fixture-key',
    model: 'fixture-model',
  };
}

function event(): CapturedEvent {
  return {
    eventId: randomUUID(),
    repositoryId: randomUUID(),
    sessionId: randomUUID(),
    sequence: 1,
    startedAt: '2026-10-21T00:00:00Z',
    endedAt: '2026-10-21T00:00:01Z',
    command: { executable: 'node', args: ['check.mjs'], shell: 'direct' },
    cwd: '.',
    git: { commitSha: null, dirty: false },
    outcome: { kind: 'completed', exitCode: 1, signal: null },
    capture: { complete: true, truncatedBytes: 0, redacted: true },
    output: [
      {
        ordinal: 0,
        stream: 'stderr',
        text: 'Missing configuration\npassword=local-fixture-secret',
      },
    ],
    diffs: [],
  };
}

function completion(sourceId: string) {
  return JSON.stringify({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            title: 'Recorded configuration failure',
            summary: 'The command exited with code 1.',
            steps: [{ text: 'A missing configuration error was recorded.', sourceIds: [sourceId] }],
            uncertainty: ['The cause has not been independently verified.'],
          }),
        },
      },
    ],
  });
}

describe('enrichment over real loopback HTTP with labeled test responses', () => {
  it('sends bounded redacted evidence and accepts an actually received cited response', async () => {
    const captured = event();
    let received = '';
    let authorization = '';
    let requestPath = '';
    const config = await provider((request, response) => {
      requestPath = request.url ?? '';
      authorization = request.headers.authorization ?? '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        received += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(completion(captured.eventId));
      });
    });
    const memory = await createEnricher(config)(captured);
    expect(requestPath).toBe('/v1/chat/completions');
    expect(authorization).toBe('Bearer transport-fixture-key');
    const request = JSON.parse(received) as {
      max_completion_tokens: number;
      messages: Array<{ content: string }>;
    };
    expect(request.max_completion_tokens).toBe(1800);
    expect(request.messages[1]?.content).toContain(captured.eventId);
    expect(received).not.toContain('local-fixture-secret');
    expect(memory).toMatchObject({ id: captured.eventId, mode: 'ai', outcome: 'exit 1' });
    expect(memory.sources.map((source) => source.id)).toEqual([captured.eventId]);
    expect(memory.provenance?.provider).toBe('127.0.0.1');
  });

  it('rejects real provider outages and invented citations', async () => {
    let unavailable = true;
    const config = await provider((_request, response) => {
      response.writeHead(unavailable ? 429 : 200, { 'content-type': 'application/json' });
      response.end(unavailable ? '{}' : completion(randomUUID()));
    });
    const enrich = createEnricher(config);
    await expect(enrich(event())).rejects.toThrow('429');
    unavailable = false;
    await expect(enrich(event())).rejects.toThrow('outside');
  });

  it('does not follow a redirect that could forward the provider credential', async () => {
    const paths: string[] = [];
    const config = await provider((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(307, { location: '/elsewhere' });
      response.end();
    });
    await expect(createEnricher(config)(event())).rejects.toThrow();
    expect(paths).toEqual(['/v1/chat/completions']);
  });

  it('stops reading an oversized HTTP response', async () => {
    const config = await provider((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ padding: 'x'.repeat(300_000) }));
    });
    await expect(createEnricher(config)(event())).rejects.toThrow('size limit');
  });

  it('aborts an HTTP connection that never returns a completion', async () => {
    const config = await provider((request, _response) => {
      request.resume();
    });
    await expect(createEnricher({ ...config, timeoutMs: 1000 })(event())).rejects.toThrow();
  });
});
