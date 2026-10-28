// Measure each shipped code file independently, as HTTP compression does.
// Usage: node package-size.mjs SITE [--brotli-budget=BYTES] [--requests=FILE]
// FILE is a JSON array of requested URLs from a cold browser navigation.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2]);
const option = name => process.argv.slice(3).find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const requests = option('requests') ? JSON.parse(await readFile(option('requests'), 'utf8')).map(url => decodeURIComponent(new URL(url).pathname)) : null;
const files = [];
function sections(bytes) {
  const names = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'data-count'];
  const result = [];
  for (let offset = 8; offset < bytes.length;) {
    const id = bytes[offset++];
    let length = 0, shift = 0, byte;
    do { byte = bytes[offset++]; length += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    result.push({ name: names[id] ?? id, raw: length });
    offset += length;
  }
  return result;
}
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await walk(path);
    else if (/\.(wasm|js|nshc)$/.test(item.name)) {
      const bytes = await readFile(path), name = relative(root, path).replaceAll('\\', '/');
      if (process.argv.includes('--require-browser') && name.endsWith('.wasm')) {
        const module = await WebAssembly.compile(bytes);
        const exports = WebAssembly.Module.exports(module).map(entry => entry.name);
        if (!exports.includes('nsh_browser_initialize') || exports.includes('nsh_start_bytecode')) {
          throw new Error(`${name} is not a browser-only runtime`);
        }
      }
      files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), raw: bytes.length,
        sections: name.endsWith('.wasm') ? sections(bytes) : undefined,
        gzip: gzipSync(bytes, { level: 9, mtime: 0 }).length,
        brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
        initial: requests ? requests.some(url => url.endsWith('/' + name)) : null });
    }
  }
}
await walk(root);
const sum = selected => Object.fromEntries(['raw', 'gzip', 'brotli'].map(key => [key, selected.reduce((n, file) => n + file[key], 0)]));
const total = sum(files);
console.log(JSON.stringify({ methodology: 'Per-file gzip level 9; Brotli quality 11; code only (Wasm, JS, bytecode), decimal bytes. Excludes fonts/media/HTML and HTTP overhead.', total, wasm: sum(files.filter(f => f.name.endsWith('.wasm'))), initial: requests ? sum(files.filter(f => f.initial)) : null, optional: requests ? sum(files.filter(f => !f.initial)) : null, files: files.sort((a,b) => a.name.localeCompare(b.name)) }, null, 2));
const budget = option('brotli-budget');
if (budget && total.brotli > Number(budget)) { console.error(`Total code Brotli ${total.brotli} exceeds budget ${budget}`); process.exitCode = 1; }
