import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const major = Number(process.versions.node.split('.')[0]);
const checks = [
  ['Supported Node.js (24 or 26)', major === 24 || major === 26],
  ['Installed dependencies', existsSync(resolve(root, 'node_modules'))],
  ['Product requirements', existsSync(resolve(root, 'docs/PRD.md'))],
  ['Project guidance', existsSync(resolve(root, 'AGENTS.md'))],
  ['Shared contracts built', existsSync(resolve(root, 'packages/contracts/dist/index.js'))],
];
for (const [label, passed] of checks) console.log(`${passed ? 'OK' : 'MISSING'}  ${label}`);
console.log(
  existsSync(resolve(root, '.env'))
    ? 'INFO  Local .env exists (contents not printed).'
    : 'INFO  No .env; web/API use local defaults.',
);
const dataDir = process.env.MEMVORA_DATA_DIR ?? resolve(root, '.memvora');
console.log(
  existsSync(resolve(dataDir, 'local-token'))
    ? 'INFO  Local API credential exists (not printed).'
    : 'INFO  Start the API once to create its local credential.',
);
console.log(
  existsSync(resolve(dataDir, 'server.sqlite'))
    ? 'INFO  Local SQLite evidence database exists.'
    : 'INFO  Local SQLite database will be created by API startup.',
);
console.log(
  'INFO  This is a local personal MVP. Hosted authentication, GitHub App synchronization and PostgreSQL deployment remain separate work.',
);
process.exitCode = checks.every(([, passed]) => passed) ? 0 : 1;
