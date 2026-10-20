import 'server-only';
import { NextResponse } from 'next/server';
import { trustedLocalHost } from './api';

export const githubOAuthCookie = 'memvora_github_oauth';
export const githubOAuthCookiePath = '/api/github/oauth';

export function localRequestOrigin(request: Request): URL | null {
  const host = request.headers.get('host');
  if (!trustedLocalHost(host)) return null;
  try {
    const url = new URL(request.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !trustedLocalHost(url.host) ||
      url.username ||
      url.password
    )
      return null;
    // NextRequest normalizes loopback URL names to localhost; Host retains the browser address.
    const origin = new URL(`${url.protocol}//${host}`);
    return url.port === origin.port ? origin : null;
  } catch {
    return null;
  }
}

export function privateOAuthResponse(response: NextResponse): NextResponse {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

export function clearOAuthCookie(response: NextResponse, secure: boolean): NextResponse {
  response.cookies.set(githubOAuthCookie, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: githubOAuthCookiePath,
    maxAge: 0,
  });
  return privateOAuthResponse(response);
}

export function oauthResult(
  request: Request,
  status: 'connected' | 'denied' | 'failed',
): NextResponse {
  const origin = localRequestOrigin(request);
  if (!origin)
    return clearOAuthCookie(
      NextResponse.json({ error: { message: 'Use a trusted local address.' } }, { status: 403 }),
      false,
    );
  const destination = new URL('/settings', origin);
  destination.searchParams.set('github', status);
  return clearOAuthCookie(NextResponse.redirect(destination, 303), origin.protocol === 'https:');
}
