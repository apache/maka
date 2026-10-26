/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(root, 'third-party/playwright');
const manifest = JSON.parse(await readFile(join(directory, 'upstream.json'), 'utf8'));
const names = ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt', 'injected.js', 'keyboard.json'];
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
if (manifest.repository !== 'https://github.com/microsoft/playwright'
    || manifest.registry_package !== 'playwright-core'
    || manifest.registry_version !== '1.58.2'
    || manifest.archive.url !== 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.58.2.tgz'
    || manifest.extraction.source !== 'package/lib/generated/injectedScriptSource.js'
    || manifest.keyboard?.source !== 'package/lib/server/usKeyboardLayout.js'
    || Object.keys(manifest.files).sort().join() !== names.slice().sort().join()) {
  throw new Error('Review the pinned upstream manifest and extraction recipe before changing the dependency.');
}

// This parser accepts the pinned data grammar only: string-keyed objects,
// integer/string values, whitespace and line comments. No expression, identifier,
// call, property access or package module is evaluated.
function keyboardData(source) {
  const marker = 'const USKeyboardLayout = ';
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0)
    throw new Error('Upstream keyboard assignment changed');
  let cursor = start + marker.length;
  const reject = () => { throw new Error(`Unsupported keyboard data syntax at ${cursor}`); };
  const whitespace = () => {
    while (cursor < source.length) {
      if (/\s/u.test(source[cursor])) cursor++;
      else if (source.startsWith('//', cursor)) {
        const end = source.indexOf('\n', cursor);
        cursor = end < 0 ? source.length : end + 1;
      } else break;
    }
  };
  const string = () => {
    const quote = source[cursor++];
    if (quote !== '"' && quote !== "'") return reject();
    let result = '';
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === quote) return result;
      if (char === '\n' || char === '\r' || char.charCodeAt(0) < 32) return reject();
      if (char !== '\\') { result += char; continue; }
      const escaped = source[cursor++];
      const escapes = { '\\': '\\', "'": "'", '"': '"', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };
      if (!Object.hasOwn(escapes, escaped)
          || (escaped === '0' && /[0-9]/u.test(source[cursor] ?? ''))) return reject();
      result += escapes[escaped];
    }
    return reject();
  };
  const value = () => {
    whitespace();
    if (source[cursor] === '{') return object();
    if (source[cursor] === '"' || source[cursor] === "'") return string();
    const match = /^(?:0|[1-9][0-9]*)/u.exec(source.slice(cursor));
    if (!match) return reject();
    cursor += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number)) return reject();
    return number;
  };
  const object = () => {
    if (source[cursor++] !== '{') return reject();
    const result = Object.create(null);
    whitespace();
    while (source[cursor] !== '}') {
      const key = string();
      if (Object.hasOwn(result, key)) return reject();
      whitespace();
      if (source[cursor++] !== ':') return reject();
      result[key] = value();
      whitespace();
      if (source[cursor] !== ',') break;
      cursor++;
      whitespace();
    }
    if (source[cursor++] !== '}') return reject();
    return result;
  };
  const layout = value();
  whitespace();
  if (source[cursor++] !== ';' || !layout || typeof layout !== 'object') return reject();
  const fields = new Set(['keyCode', 'keyCodeWithoutLocation', 'key', 'text', 'location', 'shiftKey', 'shiftKeyCode']);
  for (const [code, definition] of Object.entries(layout)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(code) || !definition || typeof definition !== 'object'
        || typeof definition.key !== 'string' || !Number.isInteger(definition.keyCode)) return reject();
    for (const [field, entry] of Object.entries(definition)) {
      if (!fields.has(field) || (['key', 'text', 'shiftKey'].includes(field)
          ? typeof entry !== 'string' : !Number.isInteger(entry))) return reject();
    }
  }
  return Buffer.from(JSON.stringify(layout, null, 2) + '\n');
}

const action = process.argv[2] ?? '--check';
if (!['--check', '--refresh'].includes(action) || process.argv.length > 3)
  throw new Error('Usage: node scripts/computer-use-parity/update-playwright.mjs [--check|--refresh]');
if (action === '--refresh') {
  const response = await fetch(manifest.archive.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Upstream package HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (hash(archive) !== manifest.archive.sha256
      || `sha512-${hash(archive, 'sha512', 'base64')}` !== manifest.archive.integrity)
    throw new Error('Upstream archive checksum mismatch');
  const temporary = await mkdtemp(join(tmpdir(), 'maka-playwright-vendor-'));
  try {
    const archivePath = join(temporary, 'package.tgz');
    await writeFile(archivePath, archive);
    const extract = (member) => execFileSync('tar', ['-xOzf', archivePath, member], {maxBuffer: 16 * 1024 * 1024});
    const module = extract(manifest.extraction.source);
    if (hash(module) !== manifest.extraction.source_sha256)
      throw new Error('Generated upstream module checksum mismatch');
    // Decode one validated JavaScript string literal. No package module,
    // install script, original application artifact, or browser is executed.
    const line = module.toString('utf8').split('\n').find(line => line.startsWith('const source = '));
    if (!line?.endsWith(';')) throw new Error('Upstream source assignment changed');
    const literal = line.slice('const source = '.length, -1);
    if (!/^'(?:[^'\\\r\n]|\\[^\r\n])*'$/u.test(literal))
      throw new Error('Expected a single source string literal');
    const source = runInNewContext(`(${literal})`, Object.create(null), {timeout:1000});
    if (typeof source !== 'string') throw new Error('Expected the upstream source string');
    const keyboardModule = extract(manifest.keyboard.source);
    if (hash(keyboardModule) !== manifest.keyboard.source_sha256)
      throw new Error('Upstream keyboard module checksum mismatch');
    const outputs = new Map([
      ['keyboard.json', keyboardData(keyboardModule.toString('utf8'))],
      ['injected.js', Buffer.from(source)],
      ...names.filter(name => name !== 'injected.js' && name !== 'keyboard.json').map(name => [name, extract(`package/${name}`)]),
    ]);
    for (const [name, bytes] of outputs) {
      if (hash(bytes) !== manifest.files[name]) throw new Error(`Extracted ${name} checksum mismatch`);
    }
    for (const [name, bytes] of outputs) await writeFile(join(directory, name), bytes);
  } finally {
    await rm(temporary, {recursive:true, force:true});
  }
}
for (const name of names) {
  if (hash(await readFile(join(directory, name))) !== manifest.files[name])
    throw new Error(`Vendored ${name} checksum mismatch`);
}
console.log(`Playwright ${manifest.registry_version}: ${names.length} pinned files verified`);
