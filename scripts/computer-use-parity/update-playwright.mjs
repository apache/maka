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
const names = ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt', 'injected.js'];
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
if (manifest.repository !== 'https://github.com/microsoft/playwright'
    || manifest.registry_package !== 'playwright-core'
    || manifest.registry_version !== '1.58.2'
    || manifest.archive.url !== 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.58.2.tgz'
    || manifest.extraction.source !== 'package/lib/generated/injectedScriptSource.js'
    || Object.keys(manifest.files).sort().join() !== names.slice().sort().join()) {
  throw new Error('Review the pinned upstream manifest and extraction recipe before changing the dependency.');
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
    const outputs = new Map([
      ['injected.js', Buffer.from(source)],
      ...names.filter(name => name !== 'injected.js').map(name => [name, extract(`package/${name}`)]),
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
