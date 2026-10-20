import { resolve } from 'node:path';
import { runEnrichmentOnce } from '@memvora/core';
import { resolveDataDir, SqliteEvidenceStore } from '@memvora/db';
import { configuredEnricher } from '@memvora/enrichment';

if (process.env['NODE_ENV'] === 'production')
  throw new Error('The SQLite worker is for the local MVP only.');
const path = resolve(resolveDataDir(), 'server.sqlite');
const enricher = configuredEnricher();
if (process.argv.includes('--check-config')) {
  console.error(
    `Local worker storage path: ${path}. Configuration syntax only; no database was opened.`,
  );
} else {
  const store = new SqliteEvidenceStore(path);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopping = true;
    });
  console.error('Local evidence worker started. Default summaries are deterministic observations.');
  try {
    while (!stopping) {
      await runEnrichmentOnce(store, enricher);
      await new Promise((done) => setTimeout(done, 750));
    }
  } finally {
    store.close();
  }
}
