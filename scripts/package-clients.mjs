import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  ARTIFACT_LIMIT,
  assertBuiltinImports,
  auditPackedFiles,
  gunzipBounded,
  regularFiles,
  sha256,
  tarEntries,
} from './lib/client-artifact.mjs';
import { collectClientNotices } from './lib/client-notices.mjs';

const root = resolve(import.meta.dirname, '..');
const engines = '^24.0.0 || ^26.0.0';
const name = '@memvora/clients';

function write(path, text, executable = false) {
  writeFileSync(path, text, { flag: 'wx', mode: executable ? 0o755 : 0o600 });
  if (executable) chmodSync(path, 0o755);
}
function regularDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('Client package output must use a regular local directory.');
}
function npmEntry() {
  const candidates = [
    process.env['npm_execpath'],
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  for (const item of (pathKey ? (process.env[pathKey] ?? '') : '').split(delimiter)) {
    if (!isAbsolute(item)) continue;
    candidates.push(join(item, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (process.platform !== 'win32') {
      try {
        candidates.push(realpathSync(join(item, 'npm')));
      } catch {
        /* Try the next explicit PATH entry. */
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const path = realpathSync(candidate);
      if (!/[/\\]npm[/\\]bin[/\\]npm-cli\.js$/u.test(path) || !lstatSync(path).isFile()) continue;
      if (
        JSON.parse(readFileSync(join(dirname(path), '..', 'package.json'), 'utf8')).name === 'npm'
      )
        return path;
    } catch {
      /* No shell wrappers or implicit cwd executable discovery. */
    }
  }
  throw new Error(
    'An existing npm JavaScript entrypoint could not be located. Run through npm or install npm with Node.',
  );
}
async function pack(directory, destination, configuration, globalConfiguration) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (
      /^(?:npm_config_|MEMVORA_|GITHUB_|GH_TOKEN$|AI_API_KEY$|NPM_TOKEN$|NODE_AUTH_TOKEN$)/iu.test(
        key,
      )
    )
      delete environment[key];
  Object.assign(environment, {
    NPM_CONFIG_USERCONFIG: configuration,
    NPM_CONFIG_GLOBALCONFIG: globalConfiguration,
    NPM_CONFIG_CACHE: join(destination, 'npm-cache'),
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1',
  });
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      [
        npmEntry(),
        'pack',
        '--json',
        '--ignore-scripts',
        '--offline',
        '--pack-destination',
        destination,
      ],
      {
        cwd: directory,
        env: environment,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Private npm packing failed; the incomplete staging directory was retained.'),
          );
          return;
        }
        try {
          done(JSON.parse(stdout));
        } catch {
          reject(new Error('Private npm packing returned invalid metadata.'));
        }
      },
    );
  });
}
function launcher(entry, mcp = false) {
  return `#!/usr/bin/env node\n// Private Memvora client launcher. No environment files or stores are loaded here.\nconst major = Number(process.versions.node.split('.')[0]);\nif (major !== 24 && major !== 26) {\n  process.stderr.write('Memvora requires Node 24 or 26.\\n');\n  process.exitCode = 1;\n} else {\n  ${mcp ? `if (process.argv.includes('--help')) { process.stdout.write('memvora-mcp: read-only stdio client. Set MEMVORA_API_URL and MEMVORA_DATA_DIR or a private MEMVORA_LOCAL_TOKEN override.\\n'); } else ` : ''}{ await import('../dist/${entry}.mjs'); }\n}\n`;
}
const readme = (version) =>
  `# Memvora private clients ${version}\n\nThis local tarball installs the memvora CLI and read-only memvora-mcp stdio adapter. It does not contain or start the website, API or worker. Node 24 or26 and npm are required. This package is private and has no install hooks or runtime npm dependencies.\n\nInstall with npm install --ignore-scripts /absolute/path/to/memvora-clients-${version}.tgz in a separate folder, or select an explicit private global prefix. Use the installed memvora bin or node /absolute/installed/package/bin/memvora.mjs. Windows npm creates a .cmd shim; the direct Node entry also works without PowerShell script execution.\n\nStart your existing local API separately. For CLI use --api-url with its loopback origin and --home with the absolute existing server data directory. Equivalent environment settings are MEMVORA_API_URL and MEMVORA_DATA_DIR. A private MEMVORA_LOCAL_TOKEN environment override can replace the data-directory token read. Do not paste credentials into shared configurations. No package command loads .env, guesses or migrates a server store. Help/version and offline outbox inspection require no credentials.\n\nFor an MCP host, launch Node with the absolute installed bin/memvora-mcp.mjs path and explicit API/data-directory environment. Default stdout belongs only to the MCP protocol. Every tool calls the same authenticated loopback API and is read-only. The client neither opens the server database nor runs retrieved commands.\n\nCapture bindings and outboxes remain in the capture project's .memvora. Upgrade by installing another reviewed tarball into the chosen client installation. Remove only that client package; retain capture projects and the server data directory. Distribution remains a private local artifact; no registry publication or upload is performed.\n\nThis package includes project code under its existing private/UNLICENSED policy and upstream dependencies under their own retained notices in THIRD_PARTY_NOTICES.md, licenses/ and dist/*.LEGAL.txt. Neither package installation nor a successful command verifies a causal fix.\n`;

export async function packageClients() {
  if (![24, 26].includes(Number(process.versions.node.split('.')[0])))
    throw new Error('Client packaging requires Node24 or26.');
  const runtimePath = join(root, 'packages/core/dist/client-runtime.js');
  if (!existsSync(runtimePath))
    throw new Error('Build shared packages before packaging the private clients.');
  const { CLIENT_VERSION } = await import(pathToFileURL(runtimePath).href);
  if (CLIENT_VERSION !== '0.6.0')
    throw new Error('Built client version does not match the reviewed private package version.');
  for (const app of ['cli', 'mcp'])
    if (
      JSON.parse(readFileSync(join(root, 'apps', app, 'package.json'), 'utf8')).version !==
      CLIENT_VERSION
    )
      throw new Error('Client app package versions must match the built release version.');
  const data = join(root, '.memvora');
  if (!existsSync(data)) mkdirSync(data, { mode: 0o700 });
  regularDirectory(data);
  const output = join(data, 'client-packages');
  if (!existsSync(output)) mkdirSync(output, { mode: 0o700 });
  regularDirectory(output);
  const run = mkdtempSync(join(output, 'clients-'));
  const directory = join(run, 'package');
  mkdirSync(directory, { mode: 0o700 });
  for (const subdirectory of ['bin', 'dist', 'licenses'])
    mkdirSync(join(directory, subdirectory), { mode: 0o700 });
  const metafiles = [];
  for (const [entry, source] of [
    ['cli', 'apps/cli/src/index.ts'],
    ['mcp', 'apps/mcp/src/index.ts'],
  ]) {
    let result;
    try {
      result = await build({
        absWorkingDir: root,
        entryPoints: [source],
        outfile: join(directory, 'dist', `${entry}.mjs`),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        conditions: ['node'],
        define: { __MEMVORA_PORTABLE_CLIENT__: 'true' },
        legalComments: 'linked',
        metafile: true,
        sourcemap: false,
        minify: false,
        logLevel: 'silent',
        banner: {
          js: `import { createRequire as __memvoraCreateRequire } from 'node:module'; const require = __memvoraCreateRequire(import.meta.url);`,
        },
      });
    } catch {
      throw new Error('Private client bundling failed. Resolve the source build before packing.');
    }
    assertBuiltinImports(result.metafile);
    metafiles.push(result.metafile);
    const text = readFileSync(join(directory, 'dist', `${entry}.mjs`), 'utf8');
    if (
      text.includes(root) ||
      text.includes(root.replaceAll('\\', '/')) ||
      text.includes('sourceMappingURL=')
    )
      throw new Error('Client bundle contains a source-checkout path or source map.');
  }
  const inventory = await collectClientNotices(root, metafiles, join(directory, 'licenses'));
  write(
    join(directory, 'THIRD_PARTY_NOTICES.md'),
    `# Bundled dependency notices\n\nProject code remains private. Dependency licenses and upstream SDK transition notices are retained verbatim in the listed files. SDK-prebundled versions are inventoried separately from installed versions.\n\n${inventory.map((item) => `- ${item.name}@${item.version}${item.embedded ? ' (upstream prebundled)' : ''}: ${item.notice}`).join('\n')}\n`,
  );
  write(join(directory, 'README.md'), readme(CLIENT_VERSION));
  write(join(directory, 'bin', 'memvora.mjs'), launcher('cli'), true);
  write(join(directory, 'bin', 'memvora-mcp.mjs'), launcher('mcp', true), true);
  write(
    join(directory, 'BUILD_MANIFEST.json'),
    `${JSON.stringify({ format: 'memvora-client-package', schemaVersion: 1, version: CLIENT_VERSION, nodeEngines: engines, dependencies: inventory, bundles: ['cli', 'mcp'].map((entry) => ({ path: `dist/${entry}.mjs`, sha256: sha256(readFileSync(join(directory, 'dist', `${entry}.mjs`))) })) }, null, 2)}\n`,
  );
  const allowed = regularFiles(directory).map((file) => file.path);
  const fixed = [
    'bin/memvora.mjs',
    'bin/memvora-mcp.mjs',
    'dist/cli.mjs',
    'dist/mcp.mjs',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'BUILD_MANIFEST.json',
  ];
  if (
    allowed.some(
      (path) =>
        !fixed.includes(path) &&
        !/^dist\/(?:cli|mcp)\.mjs\.LEGAL\.txt$/u.test(path) &&
        !inventory.some((item) => item.notice === path),
    )
  )
    throw new Error('Unexpected client staging file.');
  write(
    join(directory, 'package.json'),
    `${JSON.stringify({ name, version: CLIENT_VERSION, private: true, type: 'module', description: 'Private Memvora CLI and read-only MCP clients', author: 'harshitgupta31415', license: 'UNLICENSED', engines: { node: engines }, bin: { memvora: './bin/memvora.mjs', 'memvora-mcp': './bin/memvora-mcp.mjs' }, files: [...allowed], dependencies: {} }, null, 2)}\n`,
  );
  const files = regularFiles(directory);
  if (files.length > 128 || files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024)
    throw new Error('Client staging output exceeds its admission limit.');
  const npmConfiguration = join(run, 'empty.npmrc');
  const globalConfiguration = join(run, 'empty-global.npmrc');
  write(npmConfiguration, 'audit=false\nfund=false\nupdate-notifier=false\n');
  write(globalConfiguration, 'audit=false\nfund=false\nupdate-notifier=false\n');
  const packed = await pack(directory, run, npmConfiguration, globalConfiguration);
  const filename = `memvora-clients-${CLIENT_VERSION}.tgz`;
  if (
    !Array.isArray(packed) ||
    packed.length !== 1 ||
    packed[0].filename !== filename ||
    packed[0].name !== name ||
    packed[0].version !== CLIENT_VERSION ||
    !Array.isArray(packed[0].files)
  )
    throw new Error('npm package metadata did not match the reviewed artifact.');
  const reported = packed[0].files.map((file) => file.path).sort();
  if (JSON.stringify(reported) !== JSON.stringify(files.map((file) => file.path).sort()))
    throw new Error('npm package membership differs from the staging allowlist.');
  const tarball = join(run, filename);
  const stat = lstatSync(tarball);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > ARTIFACT_LIMIT
  )
    throw new Error('Packed client artifact is invalid or exceeds its size limit.');
  const bytes = readFileSync(tarball);
  auditPackedFiles(tarEntries(await gunzipBounded(bytes)), files);
  const report = {
    format: 'memvora-private-clients',
    version: CLIENT_VERSION,
    tarball,
    sha256: sha256(bytes),
    byteLength: stat.size,
    packageDirectory: directory,
    files,
    builtAt: new Date().toISOString(),
    nodeEngines: engines,
  };
  const reportPath = join(run, 'report.json');
  write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const latest = join(output, 'latest.json');
  if (existsSync(latest)) {
    const entry = lstatSync(latest);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
      throw new Error('The client package report path is not a regular local file.');
  }
  const temporary = join(output, `latest-${run.slice(run.lastIndexOf('clients-'))}.json`);
  write(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, latest);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await packageClients();
    console.log(`Created private clients ${result.version}: ${result.tarball}`);
    console.log(
      `Audited ${result.files.length} files; SHA-256 ${result.sha256}. No package was published or uploaded.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Packaging prerequisites failed.';
    console.error(
      `Private client packaging failed: ${message.slice(0, 300)} Any incomplete private staging directory was retained. No artifact report was updated.`,
    );
    process.exitCode = 1;
  }
}
