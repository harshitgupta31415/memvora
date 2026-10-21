import { resolve } from 'node:path';
import { runEnrichmentOnce, runSessionSynthesisOnce } from '@memvora/core';
import { resolveDataDir, SqliteEvidenceStore } from '@memvora/db';
import { configuredEnricher, configuredSessionSynthesizer } from '@memvora/enrichment';

if (process.env['NODE_ENV'] === 'production')
  throw new Error('The SQLite worker is for the local MVP only.');
const path = resolve(resolveDataDir(), 'server.sqlite');
const enricher = configuredEnricher();
const synthesis = configuredSessionSynthesizer();
if (process.argv.includes('--check-config')) {
  console.error(
    `Local worker storage path: ${path}. Configuration syntax only; no database was opened.`,
  );
} else {
  const store = new SqliteEvidenceStore(path);
  let stopping = false;
  let preferSynthesis = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopping = true;
    });
  console.error(
    'Local evidence worker started. Session synthesis processes explicit requests only.',
  );
  try {
    while (!stopping) {
      const synthesisFirst = preferSynthesis;
      preferSynthesis = !preferSynthesis;
      if (synthesisFirst) {
        if (!(await runSessionSynthesisOnce(store, synthesis)))
          await runEnrichmentOnce(store, enricher);
      } else if (!(await runEnrichmentOnce(store, enricher)))
        await runSessionSynthesisOnce(store, synthesis);
      await new Promise((done) => setTimeout(done, 750));
    }
  } finally {
    store.close();
  }
}
