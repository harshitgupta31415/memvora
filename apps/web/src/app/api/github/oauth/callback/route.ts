import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { GitHubOAuthFinishSchema } from '@memvora/contracts';
import { apiRequest } from '@/lib/api';
import { githubOAuthCookie, localRequestOrigin, oauthResult } from '@/lib/github-oauth';

function single(parameters: URLSearchParams, name: string, maximum: number): string | null {
  const values = parameters.getAll(name);
  return values.length === 1 && values[0] && values[0].length <= maximum ? values[0] : null;
}

export async function GET(request: Request) {
  if (!localRequestOrigin(request)) return oauthResult(request, 'failed');
  const parameters = new URL(request.url).searchParams;
  const state = single(parameters, 'state', 128);
  const code = single(parameters, 'code', 2048);
  const error = single(parameters, 'error', 100);
  const nonce = (await cookies()).get(githubOAuthCookie)?.value;
  const hasCode = parameters.has('code');
  const hasError = parameters.has('error');
  if (
    !state ||
    !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
    !nonce ||
    !/^[A-Za-z0-9_-]{43}$/u.test(nonce) ||
    hasCode === hasError ||
    (hasCode && !code) ||
    (hasError && !error)
  )
    return oauthResult(request, 'failed');
  // Descriptions, callback installation IDs, and other provider parameters grant no access.
  const result = await apiRequest('/v1/github/oauth/finish', GitHubOAuthFinishSchema, {
    method: 'POST',
    body: {
      state,
      browserHash: createHash('sha256').update(nonce).digest('hex'),
      ...(code ? { code } : { error }),
    },
  });
  return oauthResult(request, result.ok ? result.data.status : 'failed');
}
