import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareSessionNote } from './session-notes.js';

describe('user-authored note persistence boundary', () => {
  it('normalizes terminal controls before redacting, preserving readable lines and source-set identity', () => {
    const id = randomUUID();
    const ids = [randomUUID(), randomUUID()].sort();
    const input = {
      id,
      kind: 'decision' as const,
      body: '\u001b[31m  Why:\r\npass\u0000word=journal-secret\u001b[0m\u0085\u202e ',
      eventIds: [...ids].reverse(),
    };
    const result = prepareSessionNote(input);
    expect(result.input).toEqual({
      id,
      kind: 'decision',
      body: 'Why:\npassword=[REDACTED]',
      eventIds: ids,
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepareSessionNote({ ...result.input, eventIds: [...ids].reverse() }).digest).toBe(
      result.digest,
    );
    expect(JSON.stringify(result)).not.toContain('journal-secret');
    expect(input.body).toContain('journal-secret');
  });
  it('rejects blank, malformed, oversized and ambiguous source inputs without storing any text', () => {
    const base = {
      id: randomUUID(),
      kind: 'note' as const,
      body: 'A reason for the decision',
      eventIds: [] as string[],
    };
    for (const input of [
      { ...base, id: '../other' },
      { ...base, kind: 'verified' },
      { ...base, body: ' \u0000\u0085 ' },
      { ...base, body: 'x'.repeat(4001) },
      { ...base, eventIds: ['not-a-uuid'] },
      { ...base, eventIds: Array(11).fill(randomUUID()) },
      { ...base, eventIds: [base.id, base.id] },
      { ...base, author: 'forged' },
      { ...base, body: 'x'.repeat(3990) + ' token=a' },
    ])
      expect(() => prepareSessionNote(input as typeof base)).toThrow('valid note UUID');
  });
});
