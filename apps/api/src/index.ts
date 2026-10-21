import { resolve } from 'node:path';
import { loadLocalToken, resolveDataDir, SqliteEvidenceStore } from '@memvora/db';
import { configuredEnricher, configuredSessionSynthesizer } from '@memvora/enrichment';
import { buildApp } from './app.js';
import { registerGitHubRoutes } from './integrations/github.js';
import { configuredGitHubOAuth } from './integrations/github-oauth.js';

if (process.env['NODE_ENV'] === 'production')
  throw new Error(
    'This local-only MVP cannot run as a production API. Implement hosted authentication first.',
  );
const host = process.env['API_HOST'] ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error('The local MVP must bind to a loopback host.');
const port = Number(process.env['API_PORT'] ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error('API_PORT must be an integer from 1 to 65535.');
const dataDir = resolveDataDir();
const token = loadLocalToken({ create: true, dataDir });
const store = new SqliteEvidenceStore(resolve(dataDir, 'server.sqlite'));
const enricher = configuredEnricher();
const synthesis = configuredSessionSynthesizer();
const githubOAuth = configuredGitHubOAuth(store, token);
const app = buildApp({
  logger: true,
  store,
  token,
  registerIntegrations: (instance, service) => registerGitHubRoutes(instance, service, githubOAuth),
  ...(enricher ? { enricher } : {}),
  ...(synthesis ? { synthesis } : {}),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
try {
  await app.listen({ host, port });
} catch {
  await app.close();
  process.exitCode = 1;
}
