import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { isBuiltin } from 'node:module';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const ARTIFACT_LIMIT = 32 * 1024 * 1024;
export const unpackedLimit = 64 * 1024 * 1024;

export function assertBuiltinImports(metafile) {
  for (const output of Object.values(metafile.outputs))
    for (const imported of output.imports)
      if (!imported.external || !isBuiltin(imported.path))
        throw new Error('Client bundle retained a non-builtin runtime dependency.');
}

export async function gunzipBounded(bytes, maximum = unpackedLimit) {
  const stream = Readable.from([bytes]).pipe(createGunzip());
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maximum) throw new Error('Compressed package exceeds its unpacked size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}

function tarNumber(field) {
  const value = field.toString('ascii').replace(/\0.*$/u, '').trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error('Unsupported package archive number.');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid package archive size.');
  return result;
}
function safeArchivePath(value) {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('Unsafe package archive path.');
  return value;
}
function paxFields(data) {
  const fields = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid package archive metadata.');
    const countText = data.subarray(offset, space).toString('ascii');
    const count = Number(countText);
    if (
      !/^\d+$/u.test(countText) ||
      !Number.isSafeInteger(count) ||
      count < 5 ||
      offset + count > data.length ||
      data[offset + count - 1] !== 10
    )
      throw new Error('Invalid package archive metadata.');
    const text = data.subarray(space + 1, offset + count - 1).toString('utf8');
    const equals = text.indexOf('=');
    if (equals < 1) throw new Error('Invalid package archive metadata.');
    fields[text.slice(0, equals)] = text.slice(equals + 1);
    offset += count;
  }
  return fields;
}

/** Inspect bytes only: never extract archive paths or execute downloaded package code. */
export function tarEntries(bytes) {
  if (bytes.length > unpackedLimit) throw new Error('Package archive exceeds its size limit.');
  const entries = [];
  let offset = 0;
  let terminated = false;
  let next = {};
  let global = {};
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some((value) => value !== 0))
        throw new Error('Package archive has an incomplete terminator or trailing data.');
      terminated = true;
      break;
    }
    const expected = tarNumber(header.subarray(148, 156));
    const sum = header.reduce(
      (total, value, index) => total + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    if (sum !== expected) throw new Error('Package archive checksum failed.');
    const size = tarNumber(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]);
    const body = offset + 512;
    if (body + size > bytes.length || entries.length > 20_000)
      throw new Error('Invalid package archive bounds.');
    const data = bytes.subarray(body, body + size);
    offset = body + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      if (size > 16_384) throw new Error('Package archive metadata exceeds its limit.');
      const fields = paxFields(data);
      if (type === 'g') global = { ...global, ...fields };
      else next = fields;
      continue;
    }
    if (type === 'L') {
      if (size > 4096) throw new Error('Package archive name exceeds its limit.');
      next.path = data.toString('utf8').replace(/\0.*$/u, '');
      continue;
    }
    const fields = { ...global, ...next };
    next = {};
    if (fields.size !== undefined && Number(fields.size) !== size)
      throw new Error('Unsupported package archive size override.');
    const text = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/u, '');
    const prefix = text(345, 500);
    const path = safeArchivePath(fields.path ?? `${prefix ? `${prefix}/` : ''}${text(0, 100)}`);
    entries.push({ path, size, type, data });
  }
  if (!terminated) throw new Error('Package archive is missing its complete terminator.');
  return entries;
}

export function regularFiles(directory) {
  const result = [];
  function visit(location) {
    for (const entry of readdirSync(location, { withFileTypes: true })) {
      const path = join(location, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
        throw new Error('Client artifact contains a linked or non-regular file.');
      if (stat.isDirectory()) visit(path);
      else {
        if (stat.size > ARTIFACT_LIMIT)
          throw new Error('Client artifact file exceeds its size limit.');
        result.push({
          path: relative(directory, path).replaceAll('\\', '/'),
          size: stat.size,
          sha256: sha256(readFileSync(path)),
        });
      }
    }
  }
  visit(directory);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function auditPackedFiles(entries, files) {
  const expected = new Map(files.map((file) => [`package/${file.path}`, file]));
  const seen = new Set();
  for (const entry of entries) {
    if (entry.type === '5') {
      if (!['package/', 'package/bin/', 'package/dist/', 'package/licenses/'].includes(entry.path))
        throw new Error('Unexpected client artifact directory.');
      continue;
    }
    const file = expected.get(entry.path);
    if (
      !['0', '\0'].includes(entry.type) ||
      !file ||
      seen.has(entry.path) ||
      file.size !== entry.size ||
      file.sha256 !== sha256(entry.data)
    )
      throw new Error('Packed client files differ from the reviewed staging allowlist.');
    seen.add(entry.path);
  }
  if (seen.size !== expected.size)
    throw new Error('Packed client artifact omitted a required file.');
}
