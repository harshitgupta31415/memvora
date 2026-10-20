import { describe, expect, it } from 'vitest';
import { redactRepositoryText, validateFullName } from './github-client.js';

describe('GitHub repository boundaries', () => {
  it('rejects path and URL injection before executing the CLI', () => {
    expect(validateFullName('harshitgupta31415/memvora')).toBe(true);
    for (const value of [
      'https://evil.test/repo',
      '../user/repos',
      '../user',
      'owner/..',
      'owner/name?token=secret',
      'owner/name/../../user',
      'owner/name\n-X DELETE',
    ])
      expect(validateFullName(value)).toBe(false);
  });
  it('removes known credentials and private key material from repository snapshots', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    expect(
      redactRepositoryText(
        `const token = '${token}';\nclient_secret: "abcdef123456"\n-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----`,
      ),
    ).not.toContain(token);
    expect(redactRepositoryText('client_secret: "abcdef123456"')).not.toContain('abcdef123456');
    expect(
      redactRepositoryText(
        '-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----',
      ),
    ).not.toContain('\nprivate\n');
  });
});
