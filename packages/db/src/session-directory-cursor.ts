import { createHmac, timingSafeEqual } from 'node:crypto';
import { uuidPattern } from '@memvora/contracts';
import { DomainError } from '@memvora/core';

export type SessionDirectoryScope = {
  userId: string;
  workspaceId: string;
  workspaceGeneration: number;
  repositoryId: string | null;
  repositoryGeneration: number | null;
  status: 'all' | 'open' | 'closed';
  queryHash: string;
};
type Boundary = { createdAt: string; id: string };
type Payload = SessionDirectoryScope & { version: 1; boundary: Boundary };
const uuid = new RegExp(uuidPattern);
const generation = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const invalid = () =>
  new DomainError(
    'INVALID_CURSOR',
    'The investigation directory cursor is invalid or no longer applies to these filters.',
    400,
  );
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Directory navigation is independently signed from session-history snapshot cursors. */
export class SessionDirectoryCursors {
  private readonly key: Buffer;
  constructor(secret: Buffer) {
    this.key = createHmac('sha256', secret).update('memvora:session-directory:v1').digest();
  }
  encode(scope: SessionDirectoryScope, boundary: Boundary): string {
    const value: Payload = { version: 1, ...scope, boundary };
    const body = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const signed = `d1.${body}`;
    return `${signed}.${createHmac('sha256', this.key).update(signed).digest('base64url')}`;
  }
  decode(token: string, scope: SessionDirectoryScope): Boundary {
    try {
      if (
        typeof token !== 'string' ||
        token.length > 2048 ||
        !/^d1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
      )
        throw invalid();
      const [_prefix, body, signature] = token.split('.');
      if (!body || !signature) throw invalid();
      const bytes = Buffer.from(body, 'base64url');
      const supplied = Buffer.from(signature, 'base64url');
      if (bytes.toString('base64url') !== body || supplied.toString('base64url') !== signature)
        throw invalid();
      const expected = createHmac('sha256', this.key).update(`d1.${body}`).digest();
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
        throw invalid();
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const data = value as Record<string, unknown>;
      if (
        !exactKeys(data, [
          'version',
          'userId',
          'workspaceId',
          'workspaceGeneration',
          'repositoryId',
          'repositoryGeneration',
          'status',
          'queryHash',
          'boundary',
        ]) ||
        data['version'] !== 1 ||
        typeof data['userId'] !== 'string' ||
        !uuid.test(data['userId']) ||
        typeof data['workspaceId'] !== 'string' ||
        !uuid.test(data['workspaceId']) ||
        !generation(data['workspaceGeneration']) ||
        !['all', 'open', 'closed'].includes(String(data['status'])) ||
        typeof data['queryHash'] !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(data['queryHash'])
      )
        throw invalid();
      if (
        data['repositoryId'] === null
          ? data['repositoryGeneration'] !== null
          : typeof data['repositoryId'] !== 'string' ||
            !uuid.test(data['repositoryId']) ||
            !generation(data['repositoryGeneration'])
      )
        throw invalid();
      const boundary = data['boundary'];
      if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) throw invalid();
      const point = boundary as Record<string, unknown>;
      if (
        !exactKeys(point, ['createdAt', 'id']) ||
        typeof point['id'] !== 'string' ||
        !uuid.test(point['id']) ||
        typeof point['createdAt'] !== 'string' ||
        point['createdAt'].length > 40
      )
        throw invalid();
      const date = new Date(point['createdAt']);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== point['createdAt'])
        throw invalid();
      for (const key of Object.keys(scope) as (keyof SessionDirectoryScope)[])
        if (data[key] !== scope[key]) throw invalid();
      return { createdAt: point['createdAt'], id: point['id'] };
    } catch {
      throw invalid();
    }
  }
}
