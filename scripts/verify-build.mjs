import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const output = resolve(projectRoot, 'apps/web/.next');
const traces = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name.endsWith('.nft.json')) traces.push(path);
  }
}
collect(resolve(output, 'server'));
const serverTrace = resolve(output, 'next-server.js.nft.json');
if (existsSync(serverTrace)) traces.push(serverTrace);
if (!traces.length)
  throw new Error('No production server traces were found. Build the web app first.');
for (const path of traces) {
  const trace = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(trace.files)) throw new Error('An output trace is missing its file manifest.');
  for (const file of trace.files) {
    const absolute = resolve(dirname(path), file).replaceAll('\\', '/');
    if (/(?:^|\/)\.memvora(?:\/|$)|(?:^|\/)local-token$|(?:^|\/)\.env(?:\.[^/]*)?$/.test(absolute))
      throw new Error(
        'A production trace includes local evidence or environment credentials. Keep runtime data outside build artifacts.',
      );
  }
}
console.log(
  `Verified ${traces.length} server traces: local evidence, credentials and environment files are excluded.`,
);
