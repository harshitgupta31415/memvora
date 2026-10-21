import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSynthesisAnalysis, SessionSynthesisInput } from '@memvora/contracts';
import {
  configuredEnricher,
  configuredSessionSynthesizer,
  createSessionSynthesizer,
} from './index.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});
function input(): SessionSynthesisInput {
  const first = randomUUID();
  return {
    version: 1,
    sessionId: randomUUID(),
    repositoryId: randomUUID(),
    title: 'Synthetic cross-event investigation',
    sessionStatus: 'open',
    coverage: {
      totalEvents: 2,
      includedEvents: 2,
      omittedEvents: 0,
      totalNotes: 1,
      includedNotes: 1,
      omittedNotes: 0,
      excerptLimit: 1200,
      inputByteLimit: 65536,
      repositoryFilesIncluded: false,
      derivedMemoriesIncluded: false,
    },
    events: [first, randomUUID()].map((id, index) => ({
      id,
      sequence: index + 1,
      endedAt: '2026-10-21T10:00:00.000Z',
      command: 'node fixture.cjs',
      outcome: { kind: 'completed', exitCode: index ? 0 : 1 },
      commitSha: null,
      output: index ? 'validation completed' : 'timeout\npassword=synthesis-input-private-fixture',
      diff: '',
      captureIncomplete: false,
      excerpted: false,
    })),
    notes: [
      {
        id: randomUUID(),
        kind: 'decision',
        authorName: 'Synthetic owner',
        createdAt: '2026-10-21T10:00:00.000Z',
        body: 'Author reports changing the timeout; not independently verified.',
        eventIds: [first],
        excerpted: false,
      },
    ],
  };
}
function analysis(value: SessionSynthesisInput): SessionSynthesisAnalysis {
  return {
    overview: {
      text: 'Two outcomes were recorded; the cause of their difference is uncertain.',
      sourceIds: value.events.map((event) => event.id),
    },
    hypotheses: [
      {
        text: 'The reported timeout change may be relevant; this is an inference.',
        sourceIds: [value.notes[0]!.id, value.events[0]!.id],
      },
    ],
    unresolvedQuestions: [],
    suggestedChecks: [
      {
        text: 'Consider repeating the same check; it has not been run by this analysis.',
        sourceIds: [value.events[1]!.id],
      },
    ],
    uncertainty: ['A later zero exit does not prove the reported change fixed the original issue.'],
  };
}
function completion(value: unknown, finish = 'stop') {
  return JSON.stringify({
    choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }],
  });
}
async function provider(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic synthesis provider did not bind.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'session-synthesis-transport-fixture-key',
    model: 'fixture-model',
  };
}

describe('explicit session synthesis provider boundary', () => {
  it('uses independent opt-in and fingerprints endpoint/model/prompt without the credential', () => {
    const environment = {
      MEMVORA_AI_ENABLED: 'true',
      AI_BASE_URL: 'https://provider.example/v1',
      AI_API_KEY: 'private-fixture-key',
      AI_MODEL: 'fixture-model',
    };
    expect(configuredSessionSynthesizer(environment)).toBeUndefined();
    const enabled = {
      ...environment,
      MEMVORA_AI_ENABLED: 'false',
      MEMVORA_SESSION_SYNTHESIS_ENABLED: 'true',
    };
    expect(configuredEnricher(enabled)).toBeUndefined();
    const first = configuredSessionSynthesizer(enabled)!;
    const rotated = configuredSessionSynthesizer({
      ...enabled,
      AI_API_KEY: 'different-private-key',
      AI_BASE_URL: 'https://PROVIDER.example:443/v1/',
    })!;
    expect(first.configuration).toEqual(rotated.configuration);
    expect(first.configuration).toMatchObject({
      provider: 'provider.example',
      model: 'fixture-model',
      promptVersion: 'session-analysis-v2',
    });
    expect(JSON.stringify(first.configuration)).not.toContain(environment.AI_API_KEY);
    expect(() =>
      configuredSessionSynthesizer({ MEMVORA_SESSION_SYNTHESIS_ENABLED: 'true' }),
    ).toThrow();
    expect(() =>
      createSessionSynthesizer({
        baseUrl: 'http://remote.example/v1',
        apiKey: 'fixture',
        model: 'fixture',
      }),
    ).toThrow();
  });

  it('sends one bounded redacted snapshot over real HTTP and accepts cited inferences without altering observations', async () => {
    const snapshot = input();
    let received = '';
    let calls = 0;
    let authorization = '';
    let path = '';
    const config = await provider((request, response) => {
      calls++;
      path = request.url ?? '';
      authorization = request.headers.authorization ?? '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        received += chunk;
      });
      request.on('end', () => {
        const answer = analysis(snapshot);
        const echoedKey = 'session-synthesis-transport-fixture-key';
        answer.overview.text += ` ${echoedKey.slice(0, 15)}\u0000${echoedKey.slice(15)}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(completion(answer));
      });
    });
    const original = structuredClone(snapshot);
    const generated = await createSessionSynthesizer(config).synthesize(snapshot);
    expect(calls).toBe(1);
    expect(path).toBe('/v1/chat/completions');
    expect(authorization).toBe(`Bearer ${config.apiKey}`);
    const request = JSON.parse(received) as {
      max_completion_tokens: number;
      stream: boolean;
      response_format: { type: string };
      messages: Array<{ content: string }>;
    };
    expect(request.max_completion_tokens).toBe(3500);
    expect(request.stream).toBe(false);
    expect(request.response_format.type).toBe('json_object');
    const sent = JSON.parse(request.messages[1]!.content) as SessionSynthesisInput;
    expect(Buffer.byteLength(request.messages[1]!.content, 'utf8')).toBeLessThanOrEqual(65536);
    expect(received).not.toContain('synthesis-input-private-fixture');
    expect(sent.events.map((event) => event.id)).toEqual(snapshot.events.map((event) => event.id));
    expect(sent.notes[0]!.eventIds).toEqual(snapshot.notes[0]!.eventIds);
    expect(request.messages[0]!.content).toContain('unverified claims');
    expect(generated.overview.sourceIds).toEqual(snapshot.events.map((event) => event.id));
    expect(generated.hypotheses[0]!.sourceIds).toContain(snapshot.notes[0]!.id);
    expect(JSON.stringify(generated)).not.toContain(config.apiKey);
    expect(snapshot).toEqual(original);
  });

  it('rejects invented/uncited output and unknown observation fields rather than treating them as facts', async () => {
    const snapshot = input();
    let value: unknown = {
      ...analysis(snapshot),
      overview: { text: 'An unsupported claim.', sourceIds: [randomUUID()] },
    };
    let calls = 0;
    const config = await provider((_request, response) => {
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(completion(value));
    });
    const synthesize = createSessionSynthesizer(config).synthesize;
    await expect(synthesize(snapshot)).rejects.toThrow();
    value = { ...analysis(snapshot), overview: { text: 'An uncited claim.', sourceIds: [] } };
    await expect(synthesize(snapshot)).rejects.toThrow();
    value = { ...analysis(snapshot), verifiedFix: true };
    await expect(synthesize(snapshot)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('makes no call for an oversized input and rejects a response beyond the analysis byte budget', async () => {
    const snapshot = input();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        JSON.parse(
          completion({
            ...analysis(snapshot),
            uncertainty: Array.from({ length: 8 }, () => '😀'.repeat(300)),
            hypotheses: Array.from({ length: 6 }, () => ({
              text: '😀'.repeat(600),
              sourceIds: [snapshot.events[0]!.id],
            })),
            unresolvedQuestions: Array.from({ length: 6 }, () => ({
              text: '😀'.repeat(600),
              sourceIds: [snapshot.events[0]!.id],
            })),
            suggestedChecks: Array.from({ length: 6 }, () => ({
              text: '😀'.repeat(600),
              sourceIds: [snapshot.events[0]!.id],
            })),
          }),
        ),
      ),
    );
    const config = {
      baseUrl: 'https://provider.example/v1',
      apiKey: 'synthetic-key',
      model: 'fixture-model',
    };
    const tooLarge = {
      ...snapshot,
      coverage: { ...snapshot.coverage, totalEvents: 140, includedEvents: 140 },
      events: Array.from({ length: 140 }, (_unused, index) => ({
        ...snapshot.events[0]!,
        id: index ? randomUUID() : snapshot.events[0]!.id,
        sequence: index + 1,
        output: 'x'.repeat(1200),
      })),
    };
    await expect(createSessionSynthesizer(config, fetcher).synthesize(tooLarge)).rejects.toThrow(
      'bounded',
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createSessionSynthesizer(config, fetcher).synthesize(snapshot)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not retry an outage or follow a credential-bearing redirect', async () => {
    const snapshot = input();
    const paths: string[] = [];
    let redirect = false;
    const config = await provider((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(
        redirect ? 307 : 429,
        redirect ? { location: '/untrusted-target' } : { 'content-type': 'application/json' },
      );
      response.end('{}');
    });
    await expect(createSessionSynthesizer(config).synthesize(snapshot)).rejects.toThrow('429');
    expect(paths).toHaveLength(1);
    redirect = true;
    await expect(createSessionSynthesizer(config).synthesize(snapshot)).rejects.toThrow();
    expect(paths).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
  });

  it('rejects oversized, malformed or unfinished HTTP responses and cancels an idle provider', async () => {
    const snapshot = input();
    let mode = 'oversize';
    const config = await provider((request, response) => {
      if (mode === 'idle') {
        request.resume();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        mode === 'oversize'
          ? JSON.stringify({ padding: 'x'.repeat(300_000) })
          : mode === 'malformed'
            ? 'synthesis-private-malformed-fixture'
            : completion(analysis(snapshot), 'length'),
      );
    });
    const synthesizer = createSessionSynthesizer({ ...config, timeoutMs: 1000 });
    await expect(synthesizer.synthesize(snapshot)).rejects.toThrow('size limit');
    mode = 'malformed';
    await expect(synthesizer.synthesize(snapshot)).rejects.toThrow('valid JSON');
    mode = 'unfinished';
    await expect(synthesizer.synthesize(snapshot)).rejects.toThrow('incomplete');
    mode = 'idle';
    await expect(synthesizer.synthesize(snapshot)).rejects.toThrow('provider request failed');
  });
});
