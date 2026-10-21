import { describe, expect, it } from 'vitest';
import { MemorySchema, type Memory, type SearchResponse } from '@memvora/contracts';
import { Check } from 'typebox/value';
import { toolResult } from './client.js';
import {
  boundedMemory,
  buildMemoryResult,
  MEMORY_PRESENTATION_BYTE_LIMIT,
} from './presentation.js';

const repositoryId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';

function memory(index = 0): Memory {
  const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
  return {
    id,
    repositoryId,
    sessionId,
    title: 'Synthetic raw-evidence presentation fixture',
    summary: 'An accepted captured event is available while its stored summary is missing.',
    representation: 'raw_event',
    processingStatus: 'queued',
    mode: 'observed',
    label: 'Captured event — summary queued',
    outcome: 'check_failed',
    createdAt: '2026-10-21T09:00:00.000Z',
    steps: [
      { text: 'A nonzero exit was observed; it does not establish a cause.', sourceIds: [id] },
    ],
    sources: [{ id, repositoryId, kind: 'event', locator: `/v1/events/${id}` }],
    uncertainty: [
      'Computed when read from the original event; no stored summary or provider call was used.',
    ],
  };
}

describe('MCP captured-evidence presentation', () => {
  it.each(['queued', 'running', 'failed', 'ready'] as const)(
    'preserves raw classification and actual %s processing state on an individual lookup',
    (processingStatus) => {
      const input = { ...memory(), processingStatus };
      const result = buildMemoryResult({ memory: input });
      if (!('memory' in result)) throw new Error('Expected an individual result.');
      expect(result.memory).toEqual(input);
      expect(result.memory.representation).toBe('raw_event');
      expect(result.memory.processingStatus).toBe(processingStatus);
      expect(result.memory.sources).toEqual(input.sources);
      expect(result.evidenceNotice).toContain('without a stored summary');
      expect(result.excerpted).toBe(false);
    },
  );

  it('preserves missing processing state and legacy stored-summary fields without inventing defaults', () => {
    const raw = memory();
    delete raw.processingStatus;
    expect(boundedMemory(raw).processingStatus).toBeUndefined();
    const legacy = memory();
    delete legacy.processingStatus;
    delete legacy.representation;
    legacy.mode = 'ai';
    legacy.label = 'Stored AI summary fixture';
    legacy.provenance = { provider: 'fixture', model: 'fixture', promptVersion: 'fixture-v1' };
    const result = buildMemoryResult({ memory: legacy });
    if (!('memory' in result)) throw new Error('Expected an individual result.');
    expect(result.memory).toEqual(legacy);
    expect(Object.hasOwn(result.memory, 'representation')).toBe(false);
    expect(Object.hasOwn(result.memory, 'processingStatus')).toBe(false);
  });

  it.each(['\u0000', '\\"', '界😀'])(
    'keeps every hit and exact original citation inside a 96 KiB escaped envelope under %j text pressure',
    async (character) => {
      const text = character.repeat(12_000);
      const input: SearchResponse = {
        requestId: 'presentation-fixture-request',
        items: Array.from({ length: 10 }, (_, index) => ({
          ...memory(index),
          title: text,
          summary: text,
          steps: memory(index).steps.map((step) => ({ ...step, text })),
          uncertainty: [text, 'No stored summary is available; this remains captured evidence.'],
        })),
      };
      const result = buildMemoryResult(input);
      if (!('items' in result)) throw new Error('Expected search results.');
      expect(result.items.map((item) => item.id)).toEqual(input.items.map((item) => item.id));
      expect(result.requestId).toBe(input.requestId);
      expect(result.excerpted).toBe(true);
      for (const [index, item] of result.items.entries()) {
        const original = input.items[index]!;
        expect(Check(MemorySchema, item)).toBe(true);
        expect(item.representation).toBe(original.representation);
        expect(item.processingStatus).toBe(original.processingStatus);
        expect(item.sources).toEqual(original.sources);
        expect(item.steps.map((step) => step.sourceIds)).toEqual(
          original.steps.map((step) => step.sourceIds),
        );
        expect(item.label).toBe(original.label);
        expect(item.mode).toBe('observed');
        expect(item.uncertainty).toHaveLength(original.uncertainty.length);
      }
      const response = await toolResult(async () => result);
      expect(response.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(
        MEMORY_PRESENTATION_BYTE_LIMIT,
      );
      expect(JSON.stringify(response)).not.toMatch(
        /\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/i,
      );
      expect(input.items[0]!.summary).toBe(text);
    },
  );

  it('rejects unresolved/foreign citations and duplicate hits instead of presenting ungrounded evidence', () => {
    const foreign = memory();
    foreign.sources[0]!.repositoryId = '44444444-4444-4444-8444-444444444444';
    expect(() => buildMemoryResult({ memory: foreign })).toThrow('original event evidence');
    const unresolved = memory();
    unresolved.steps[0]!.sourceIds = ['44444444-4444-4444-8444-444444444444'];
    expect(() => buildMemoryResult({ memory: unresolved })).toThrow('original event evidence');
    expect(() => buildMemoryResult({ items: [memory(), memory()], requestId: 'fixture' })).toThrow(
      'distinct evidence',
    );
  });
});
