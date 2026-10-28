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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packageDigest,
  productFingerprint,
  writeProductVersion,
} from './plugins/product-version.mjs';

test('canonical fingerprints match Rust Unicode and binary vectors', () => {
  const files = [
    ['z', Buffer.from([0, 255])],
    ['😀.js', Buffer.from('你好')],
    ['\uE000.js', Buffer.from('x')],
  ];
  const digest = packageDigest(files);
  assert.equal(digest, 'sha256-1be108087645221ec647c9ce43ad7d10de9d6433c533fb2b67e1bb93609d302c');
  const packages = [
    ['b', 'two'],
    ['a', digest],
  ];
  assert.equal(
    productFingerprint('author 😀\n', packages),
    'sha256-41298191ef2403397572e03ff6aa1b82f8d5f839f32260bfa02925628406d86e',
  );
  assert.equal(packageDigest(files.reverse()), digest);
  assert.equal(
    productFingerprint('author 😀\n', packages.reverse()),
    'sha256-41298191ef2403397572e03ff6aa1b82f8d5f839f32260bfa02925628406d86e',
  );
});

test('generated version tracks exact package bytes, authoring and package names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-product-version-'));
  try {
    await mkdir(join(directory, 'authoring'));
    await mkdir(join(directory, 'packages', 'a'), { recursive: true });
    await writeFile(join(directory, 'authoring/composition.mjs'), 'author');
    await writeFile(join(directory, 'packages/a/entry.js'), 'original');
    const original = await writeProductVersion(directory, ['a']);
    assert.equal(await readFile(join(directory, 'product-version.txt'), 'utf8'), original + '\n');
    assert.equal(await writeProductVersion(directory, ['a']), original);
    await writeFile(join(directory, 'packages/a/entry.js'), 'changed');
    const changed = await writeProductVersion(directory, ['a']);
    assert.notEqual(changed, original);
    await writeFile(join(directory, 'authoring/composition.mjs'), 'changed author');
    assert.notEqual(await writeProductVersion(directory, ['a']), changed);
    assert.notEqual(await writeProductVersion(directory, []), changed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bundle command regenerates development identity after TypeScript edits', async () => {
  const { bundle } = await import('./plugins/build.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'maka-product-build-'));
  try {
    const source = join(directory, 'source');
    const output = join(directory, 'output');
    await mkdir(source);
    await writeFile(
      join(source, 'package.ts'),
      `export default {
      schemaVersion: 1, id: 'example.fingerprint',
      application: { host: { implementation: { kind: 'javascript', module: 'entry.js', realm: 'shared' }, configuration: { type: 'object' } } }
    };`,
    );
    await writeFile(join(source, 'entry.ts'), 'export function main() { return "before"; }');
    const composition = join(source, 'composition.ts');
    await writeFile(composition, 'export const composition = () => "before";');
    const options = { packages: { example: source }, output, composition };
    await bundle(options);
    const original = await readFile(join(output, 'product-version.txt'), 'utf8');
    await writeFile(join(source, 'entry.ts'), 'export function main() { return "after"; }');
    await bundle(options);
    const packageChanged = await readFile(join(output, 'product-version.txt'), 'utf8');
    assert.notEqual(packageChanged, original);
    await writeFile(composition, 'export const composition = () => "after";');
    await bundle(options);
    assert.notEqual(await readFile(join(output, 'product-version.txt'), 'utf8'), packageChanged);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
