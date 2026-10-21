import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  assertBuiltinImports,
  auditPackedFiles,
  gunzipBounded,
  sha256,
  tarEntries,
} from './client-artifact.mjs';

function archive(path, text = 'safe client bytes', type = '0') {
  const data = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header[156] = type.charCodeAt(0);
  header.fill(32, 148, 156);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

test('audits packed bytes against the exact staging allowlist rather than trusting npm JSON', () => {
  const entries = tarEntries(archive('package/dist/cli.mjs'));
  const files = [
    { path: 'dist/cli.mjs', size: 17, sha256: sha256(Buffer.from('safe client bytes')) },
  ];
  auditPackedFiles(entries, files);
  assert.throws(() => auditPackedFiles(entries, [{ ...files[0], sha256: '0'.repeat(64) }]));
  assert.throws(() => auditPackedFiles([...entries, ...entries], files));
  assert.throws(() => auditPackedFiles(tarEntries(archive('package/local-token')), files));
  assert.throws(() =>
    auditPackedFiles(tarEntries(archive('package/dist/cli.mjs', '', '2')), files),
  );
});

test('rejects traversal, malformed archive bounds and checksum changes without extraction', () => {
  assert.throws(() => tarEntries(archive('package/../local-token')));
  const altered = archive('package/package.json');
  altered[0] ^= 1;
  assert.throws(() => tarEntries(altered));
  const unterminated = archive('package/package.json').subarray(0, -1024);
  assert.throws(() => tarEntries(unterminated));
  assert.throws(() => tarEntries(Buffer.concat([unterminated, Buffer.from('short private tail')])));
  assert.throws(() =>
    tarEntries(
      Buffer.concat([
        archive('package/package.json'),
        Buffer.from('unexpected private trailing bytes'),
      ]),
    ),
  );
  assert.throws(() =>
    tarEntries(archive('package/package.json', 'x'.repeat(1024)).subarray(0, 1024)),
  );
});

test('decompression has an independent output bound', async () => {
  const compressed = gzipSync(Buffer.alloc(4096, 1));
  await assert.rejects(gunzipBounded(compressed, 1024));
  assert.equal((await gunzipBounded(compressed, 4096)).length, 4096);
});

test('bundle import audit permits only actual Node builtins', () => {
  assertBuiltinImports({
    outputs: {
      bundle: {
        imports: [
          { external: true, path: 'node:sqlite' },
          { external: true, path: 'node:crypto' },
        ],
      },
    },
  });
  for (const imported of [
    { external: true, path: '@memvora/core' },
    { external: true, path: 'zod/v4' },
    { external: true, path: 'node:node:sqlite' },
    { external: false, path: './source.js' },
  ])
    assert.throws(() => assertBuiltinImports({ outputs: { bundle: { imports: [imported] } } }));
});
