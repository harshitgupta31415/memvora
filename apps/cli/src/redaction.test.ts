import { describe, expect, it } from 'vitest';
import { StreamRedactor, redactArguments, redactText } from './redaction.js';

describe('capture redaction boundaries', () => {
  it('normalizes split Windows CRLF once and preserves genuine blank lines', () => {
    const chunks: string[] = [];
    const redactor = new StreamRedactor((text) => chunks.push(text));
    redactor.write(Buffer.from('first\r'));
    redactor.write(Buffer.from('\n\r\nsecond\r\nthird'));
    redactor.end();
    expect(chunks.join('')).toBe('first\n\nsecond\nthird');
    const omitted: string[] = [];
    const longLine = new StreamRedactor((text) => omitted.push(text), [], 3);
    longLine.write(Buffer.from('12345\r'));
    longLine.write(Buffer.from('\n'));
    longLine.end();
    expect(omitted.join('')).toBe('[REDACTED OVERLONG LINE]\n');
    expect(longLine.suppressedBytes).toBe(7);
  });
  it('redacts a known credential split across chunks before releasing any bytes', () => {
    const chunks: string[] = [];
    const redactor = new StreamRedactor(
      (text) => chunks.push(text),
      ['a-private-device-credential'],
    );
    redactor.write(Buffer.from('token=a-private-'));
    expect(chunks).toEqual([]);
    redactor.write(Buffer.from('device-credential\nordinary output\n'));
    redactor.end();
    expect(chunks.join('')).not.toContain('a-private');
    expect(chunks.join('')).toContain('ordinary output');
  });

  it('suppresses overlong lines instead of leaking an incomplete secret prefix', () => {
    const chunks: string[] = [];
    const redactor = new StreamRedactor((text) => chunks.push(text), [], 16);
    redactor.write(Buffer.from('TOKEN=abcdefghijklmnopqrstuv\nnext\n'));
    redactor.end();
    expect(chunks.join('')).toBe('[REDACTED OVERLONG LINE]\nnext\n');
    expect(redactor.suppressedBytes).toBe(Buffer.byteLength('TOKEN=abcdefghijklmnopqrstuv\n'));
  });

  it('suppresses multi-line private key bodies and common secret assignments', () => {
    const chunks: string[] = [];
    const redactor = new StreamRedactor((text) => chunks.push(text));
    redactor.write(
      Buffer.from('-----BEGIN RSA PRIVATE KEY-----\nprivatebody\n-----END RSA PRIVATE KEY-----\n'),
    );
    redactor.end();
    expect(chunks.join('')).not.toContain('privatebody');
    const redacted = redactText('API_KEY="private value" password=hidden');
    expect(redacted).not.toContain('private value');
    expect(redacted).not.toContain('hidden');
    expect(redacted).toContain('[REDACTED]');
    expect(redactArguments(['--password', 'private-password', '--port', '3000'])).toEqual([
      '--password',
      '[REDACTED]',
      '--port',
      '3000',
    ]);
    expect(
      redactArguments(['--api-key=private-api-key', '--client-secret=private-secret']),
    ).toEqual(['--api-key=[REDACTED]', '--client-secret=[REDACTED]']);
  });

  it('uses the shared policy for JSON keys and complete spaced quoted values across chunks', () => {
    const chunks: string[] = [];
    const redactor = new StreamRedactor((text) => chunks.push(text));
    redactor.write(Buffer.from('{"password":"secret with '));
    redactor.write(Buffer.from('spaces","apiKey":"another-private-value"}\n'));
    redactor.end();
    expect(chunks.join('')).not.toContain('secret with');
    expect(chunks.join('')).not.toContain('spaces');
    expect(chunks.join('')).not.toContain('another-private-value');
    expect(chunks.join('')).toContain('password');
  });
});
