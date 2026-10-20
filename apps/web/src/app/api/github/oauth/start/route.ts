import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { GitHubOAuthStartSchema } from '@memvora/contracts';
import { apiRequest, trustedMutation } from '@/lib/api';
import {
  githubOAuthCookie,
  githubOAuthCookiePath,
  localRequestOrigin,
  oauthResult,
  privateOAuthResponse,
} from '@/lib/github-oauth';

export async function POST(request: Request) {
  const origin = localRequestOrigin(request);
  if (!origin || !trustedMutation(request))
    return privateOAuthResponse(
      NextResponse.json(
        { error: { message: 'Only same-origin local requests are accepted.' } },
        { status: 403 },
      ),
    );
  const nonce = randomBytes(32).toString('base64url');
  const browserHash = createHash('sha256').update(nonce).digest('hex');
  const result = await apiRequest('/v1/github/oauth/start', GitHubOAuthStartSchema, {
    method: 'POST',
    body: { browserHash },
  });
  if (!result.ok) return oauthResult(request, 'failed');
  let authorization: URL;
  try {
    authorization = new URL(result.data.authorizationUrl);
    const callback = new URL(result.data.callbackUrl);
    if (
      authorization.protocol !== 'https:' ||
      authorization.host !== 'github.com' ||
      authorization.pathname !== '/login/oauth/authorize' ||
      authorization.username ||
      authorization.password ||
      authorization.hash ||
      callback.origin !== origin.origin ||
      callback.pathname !== '/api/github/oauth/callback' ||
      callback.search ||
      callback.hash ||
      callback.username ||
      callback.password
    )
      return oauthResult(request, 'failed');
  } catch {
    return oauthResult(request, 'failed');
  }
  const response = NextResponse.redirect(authorization, 303);
  response.cookies.set(githubOAuthCookie, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: origin.protocol === 'https:',
    path: githubOAuthCookiePath,
    maxAge: 600,
  });
  return privateOAuthResponse(response);
}
