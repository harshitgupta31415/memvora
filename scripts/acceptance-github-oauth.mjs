import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

// All provider responses and imported files are explicitly labeled test fixtures in memory.
const root = resolve(import.meta.dirname, '..');
const token = randomBytes(32).toString('base64url');
const webPort = await new Promise((resolvePort, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port;
    listener.close((error) => (error ? reject(error) : resolvePort(port)));
  });
});
const webOrigin = `http://127.0.0.1:${webPort}`;
const children = [];
function child(file, args, options = {}) {
  const value = spawn(file, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    ...options,
  });
  value.stderr.on('data', () => {});
  value.on('error', () => {});
  children.push(value);
  return value;
}
async function stop(value) {
  if (value.exitCode !== null || value.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      value.kill('SIGKILL');
      resolveStop();
    }, 5000);
    value.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    value.kill();
  });
}
let apiOrigin;
function hostileHostStatus(url, method, headers = {}) {
  // Node fetch controls Host itself; use the HTTP client to exercise an actual hostile header.
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest(
      url,
      {
        method,
        headers: { ...headers, host: 'untrusted.example' },
        signal: AbortSignal.timeout(15000),
      },
      (response) => {
        response.resume();
        response.once('end', () => resolveStatus(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end();
  });
}
try {
  const api = child(process.execPath, [resolve(root, 'scripts/github-oauth-fixture-server.mjs')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      MEMVORA_OAUTH_TEST_MODE: 'fixture-only',
      MEMVORA_LOCAL_TOKEN: token,
      MEMVORA_OAUTH_TEST_CALLBACK: `${webOrigin}/api/github/oauth/callback`,
    },
  });
  apiOrigin = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Isolated OAuth API startup timed out.')),
      15000,
    );
    api.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Isolated OAuth API failed.'));
    });
    api.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Isolated OAuth API exited.'));
    });
    api.once('message', (message) => {
      clearTimeout(timer);
      assert.equal(message.fixture, true);
      assert.equal(new URL(message.origin).hostname, '127.0.0.1');
      resolveReady(message.origin);
    });
  });
  const next = createRequire(resolve(root, 'apps/web/package.json')).resolve('next/dist/bin/next');
  child(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], {
    cwd: resolve(root, 'apps/web'),
    env: { ...process.env, MEMVORA_API_URL: apiOrigin, MEMVORA_LOCAL_TOKEN: token },
  });
  const readyDeadline = Date.now() + 30000;
  while (true) {
    try {
      const result = await fetch(`${webOrigin}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (result.ok) break;
    } catch {}
    if (Date.now() > readyDeadline)
      throw new Error('Isolated web startup timed out. Build the app before acceptance.');
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 150));
  }
  const apiRequest = async (path, body, expected = 200) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, expected, 'Isolated API returned an unexpected status.');
    return response.json();
  };
  const start = async (origin = webOrigin, extraHeaders = {}) =>
    fetch(`${webOrigin}/api/github/oauth/start`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, ...extraHeaders },
      signal: AbortSignal.timeout(15000),
    });
  assert.equal((await start('https://untrusted.example')).status, 403);
  assert.equal(
    await hostileHostStatus(`${webOrigin}/api/github/oauth/start`, 'POST', { origin: webOrigin }),
    403,
  );
  const started = await start(webOrigin, { 'x-forwarded-host': 'untrusted.example' });
  assert.equal(started.status, 303);
  const authorization = new URL(started.headers.get('location'));
  assert.equal(authorization.origin, 'https://github.com');
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    `${webOrigin}/api/github/oauth/callback`,
  );
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const cookieHeader = started.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);
  assert.match(cookieHeader, /Path=\/api\/github\/oauth/i);
  const cookie = cookieHeader.split(';')[0];
  const callback = new URL(`${webOrigin}/api/github/oauth/callback`);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'labeled-fixture-authorization-code');
  const missing = await fetch(callback, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  assert.equal(
    new URL(missing.headers.get('location'), webOrigin).searchParams.get('github'),
    'failed',
  );
  assert.equal(await hostileHostStatus(callback, 'GET', { cookie }), 403);
  const duplicate = new URL(callback);
  duplicate.searchParams.append('state', authorization.searchParams.get('state'));
  const duplicateResult = await fetch(duplicate, {
    redirect: 'manual',
    headers: { cookie },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    new URL(duplicateResult.headers.get('location'), webOrigin).searchParams.get('github'),
    'failed',
  );
  const finish = await fetch(callback, {
    redirect: 'manual',
    headers: { cookie },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(finish.status, 303);
  assert.equal(
    new URL(finish.headers.get('location'), webOrigin).searchParams.get('github'),
    'connected',
  );
  assert.match(finish.headers.get('cache-control'), /no-store/i);
  assert.equal(finish.headers.get('referrer-policy'), 'no-referrer');
  const replay = await fetch(callback, {
    redirect: 'manual',
    headers: { cookie },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    new URL(replay.headers.get('location'), webOrigin).searchParams.get('github'),
    'failed',
  );
  const status = await apiRequest('/v1/github/status');
  assert.equal(status.mode, 'github_app');
  assert.equal(status.oauth.connected, true);
  const html = await (
    await fetch(`${webOrigin}/settings`, { signal: AbortSignal.timeout(15000) })
  ).text();
  assert.ok(html.includes('fixture-owner'));
  for (const secret of [
    token,
    'acceptance-access-fixture',
    'acceptance-refresh-fixture',
    'fixture-client-secret',
  ])
    assert.ok(!html.includes(secret));
  const installations = await (await fetch(`${webOrigin}/api/github/installations?page=1`)).json();
  assert.equal(installations.items[0].id, 7);
  const repos = await (
    await fetch(`${webOrigin}/api/github/repositories?installationId=7&page=1`)
  ).json();
  assert.equal(repos.items[0].id, 12);
  const imported = await fetch(`${webOrigin}/api/github/import`, {
    method: 'POST',
    headers: { origin: webOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: 'fixture-owner/oauth-acceptance',
      installationId: 7,
      repositoryId: 12,
      repositoryPage: 1,
    }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(imported.status, 200);
  const source = await apiRequest('/v1/repository-sources/search', {
    query: 'isolatedOAuthAcceptance',
  });
  assert.equal(source.items.length, 1);
  const disconnect = await fetch(`${webOrigin}/api/github/oauth/disconnect`, {
    method: 'POST',
    headers: { origin: webOrigin, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(disconnect.status, 200);
  assert.equal((await apiRequest('/v1/github/status')).oauth.connected, false);
  await apiRequest('/v1/github/installations', undefined, 409);
  assert.equal(
    (await apiRequest('/v1/repository-sources/search', { query: 'isolatedOAuthAcceptance' })).items
      .length,
    1,
  );
  const denialStart = await start();
  const denialAuth = new URL(denialStart.headers.get('location'));
  const denialUrl = new URL(`${webOrigin}/api/github/oauth/callback`);
  denialUrl.searchParams.set('state', denialAuth.searchParams.get('state'));
  denialUrl.searchParams.set('error', 'access_denied');
  denialUrl.searchParams.set(
    'error_description',
    'Untrusted fixture description must not be rendered',
  );
  const denied = await fetch(denialUrl, {
    redirect: 'manual',
    headers: { cookie: denialStart.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(
    new URL(denied.headers.get('location'), webOrigin).searchParams.get('github'),
    'denied',
  );
  const report = {
    completedAt: new Date().toISOString(),
    mode: 'isolated_fixture_provider',
    checks: {
      sameOriginStart: true,
      hostGuard: true,
      ignoredForwardedHost: true,
      duplicateCallbackRejected: true,
      browserBinding: true,
      pkce: true,
      callbackExchange: true,
      replayRejected: true,
      noBrowserSecrets: true,
      installations: true,
      repositorySelection: true,
      boundedImport: true,
      sourceRetrieval: true,
      disconnect: true,
      denial: true,
    },
    notice:
      'Compiled web and API with an injected test provider and an in-memory database. No live GitHub authorization or user evidence was used or modified.',
  };
  const reportPath =
    process.env.MEMVORA_OAUTH_ACCEPTANCE_REPORT ?? resolve(root, '.memvora/oauth-acceptance.json');
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const value of children.reverse()) await stop(value);
}
