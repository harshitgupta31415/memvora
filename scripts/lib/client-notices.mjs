import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipBounded, tarEntries } from './client-artifact.mjs';

const licenseName = /^(?:licen[sc]e|notice|copying)(?:[.-].*)?$/iu;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u;
const maximumText = 128 * 1024;

function legalFiles(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    if (!licenseName.test(name)) continue;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumText)
      throw new Error('A dependency license file is unavailable or exceeds its supported size.');
    result.push({ name, text: readFileSync(path, 'utf8') });
  }
  return result;
}
async function fetchBytes(url, maximum) {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.hostname !== 'registry.npmjs.org' ||
    target.username ||
    target.password ||
    target.port
  )
    throw new Error('Dependency notice fetch is restricted to the official npm registry.');
  const response = await fetch(target, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json, application/octet-stream' },
  });
  if (!response.ok || !response.body)
    throw new Error('An exact dependency notice could not be fetched.');
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error('Dependency notice download exceeds its size limit.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
}
async function registryLegalFiles(name, version) {
  const metadata = JSON.parse(
    (
      await fetchBytes(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
        256 * 1024,
      )
    ).toString('utf8'),
  );
  if (
    metadata.name !== name ||
    metadata.version !== version ||
    typeof metadata.dist?.tarball !== 'string' ||
    typeof metadata.dist?.integrity !== 'string'
  )
    throw new Error('Exact dependency notice metadata did not match the bundled version.');
  const integrity = metadata.dist.integrity
    .split(/\s+/u)
    .find((value) => /^sha512-[A-Za-z0-9+/]+=*$/u.test(value));
  if (!integrity) throw new Error('Dependency notice archive lacks supported integrity metadata.');
  const compressed = await fetchBytes(metadata.dist.tarball, 8 * 1024 * 1024);
  if (`sha512-${createHash('sha512').update(compressed).digest('base64')}` !== integrity)
    throw new Error('Dependency notice archive failed its integrity check.');
  const entries = tarEntries(await gunzipBounded(compressed, 32 * 1024 * 1024));
  const files = entries.filter(
    (entry) =>
      ['0', '\0'].includes(entry.type) &&
      entry.path.startsWith('package/') &&
      !entry.path.slice(8).includes('/') &&
      licenseName.test(entry.path.slice(8)),
  );
  if (!files.length || files.some((entry) => entry.size < 1 || entry.size > maximumText))
    throw new Error('A bundled dependency has no bounded root license text in its exact archive.');
  return {
    files: files.map((entry) => ({ name: entry.path.slice(8), text: entry.data.toString('utf8') })),
    archiveIntegrity: integrity,
  };
}

/** Includes the SDK's already bundled constituents; an esbuild input list alone misses them. */
export async function collectClientNotices(projectRoot, metafiles, outputDirectory) {
  const dependencies = new Map();
  const installedRoot = join(projectRoot, 'node_modules');
  function add(name, version, directory, embedded = false) {
    if (!packageName.test(name) || !versionPattern.test(version))
      throw new Error('Unsupported bundled dependency identity.');
    const key = `${name}@${version}`;
    const existing = dependencies.get(key);
    dependencies.set(key, {
      name,
      version,
      directory: existing?.directory ?? directory,
      embedded: Boolean(existing?.embedded || embedded),
    });
  }
  for (const input of new Set(metafiles.flatMap((file) => Object.keys(file.inputs)))) {
    const path = resolve(projectRoot, input);
    if (!path.startsWith(`${installedRoot}${sep}`)) continue;
    let directory = dirname(path);
    while (directory.startsWith(`${installedRoot}${sep}`)) {
      if (existsSync(join(directory, 'package.json'))) {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        // Some exports (for example zod/v4) contain type-only nested manifests.
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
          add(manifest.name, manifest.version, directory);
          break;
        }
      }
      directory = dirname(directory);
    }
    if (!path.endsWith('.mjs') && !path.endsWith('.js')) continue;
    const size = lstatSync(path).size;
    if (size > 16 * 1024 * 1024)
      throw new Error('Bundled dependency source exceeds the inventory limit.');
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(
      /\/\/#region [^\r\n]*node_modules\/\.pnpm\/(@[^/+]+\+[^/@]+|[^/@]+)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:_[^/]*)?\/node_modules\//gu,
    )) {
      const name = match[1].startsWith('@') ? match[1].replace('+', '/') : match[1];
      const version = match[2];
      const local = join(installedRoot, ...name.split('/'));
      const metadata = join(local, 'package.json');
      const exact =
        existsSync(metadata) && JSON.parse(readFileSync(metadata, 'utf8')).version === version;
      add(name, version, exact ? local : undefined, true);
    }
  }
  if (!dependencies.size || dependencies.size > 64)
    throw new Error('Bundled dependency inventory is missing or exceeds its limit.');
  const inventory = [];
  for (const item of [...dependencies.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  )) {
    let legal = item.directory ? legalFiles(item.directory) : [];
    let archiveIntegrity;
    if (!legal.length) {
      const fetched = await registryLegalFiles(item.name, item.version);
      legal = fetched.files;
      archiveIntegrity = fetched.archiveIntegrity;
    }
    const filename = `${encodeURIComponent(item.name)}-${item.version}.txt`;
    const text = `${item.name}@${item.version}\n${item.embedded ? 'Includes code already bundled by an upstream dependency.\n' : ''}\n${legal.map((file) => `--- ${file.name} ---\n${file.text}`).join('\n\n')}`;
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
      throw new Error('Combined dependency notices exceed their limit.');
    writeFileSync(join(outputDirectory, filename), text, { flag: 'wx', mode: 0o600 });
    inventory.push({
      name: item.name,
      version: item.version,
      embedded: item.embedded,
      notice: `licenses/${filename}`,
      ...(archiveIntegrity
        ? { source: 'official-registry', archiveIntegrity }
        : { source: 'installed-package' }),
    });
  }
  return inventory;
}
