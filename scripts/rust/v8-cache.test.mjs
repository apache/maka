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
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { cachedV8, v8CacheKey } from './v8-cache.mjs';

test('V8 cache identity follows compatibility inputs and the executed producer', async () => {
  const input = {
    source: { version: '150.4.0', revision: 'pinned', gnArgs: 'v8_use_libm_trig_functions=false' },
    target: 'aarch64-apple-darwin',
    features: ['simdutf', 'use_custom_libcxx'],
  };
  const key = await v8CacheKey(input);
  assert.equal(
    await v8CacheKey({ ...input, features: ['use_custom_libcxx', 'simdutf', 'simdutf'] }),
    key,
  );
  for (const changed of [
    { ...input, target: 'x86_64-pc-windows-msvc' },
    { ...input, features: ['simdutf'] },
    { ...input, source: { ...input.source, revision: 'new-pin' } },
    { ...input, source: { ...input.source, gnArgs: 'another-build' } },
  ])
    assert.notEqual(await v8CacheKey(changed), key);
  const stage = await mkdtemp(join(tmpdir(), 'maka-v8-recipe-'));
  try {
    for (const name of ['v8-cache.mjs', 'compile-v8.mjs', 'v8-notices.mjs', 'license-files.mjs'])
      await copyFile(new URL(name, import.meta.url), join(stage, name));
    const copied = await import(pathToFileURL(join(stage, 'v8-cache.mjs')).href);
    assert.equal(await copied.v8CacheKey(input), key);
    await writeFile(join(stage, 'build-v8.mjs'), 'changed transport');
    await writeFile(join(stage, 'notices.mjs'), 'changed unrelated notice tooling');
    await writeFile(join(stage, 'v8-prebuilts.json'), '{}');
    assert.equal(await copied.v8CacheKey(input), key);
    await writeFile(join(stage, 'compile-v8.mjs'), 'changed producer');
    assert.notEqual(await copied.v8CacheKey(input), key);
    assert.equal(await v8CacheKey(input), key);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('V8 cache reuses a complete bundle and rejects corrupted or incomplete entries', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'maka v8 cache '));
  try {
    const archive = join(stage, 'built.a');
    const binding = join(stage, 'built.rs');
    await writeFile(archive, 'native archive');
    await writeFile(binding, 'matching bindings');
    const built = {
      environment: { RUSTY_V8_ARCHIVE: archive, RUSTY_V8_SRC_BINDING_PATH: binding },
      notices: 'complete V8 notices',
    };
    const options = {
      directory: join(stage, 'cache'),
      target: 'aarch64-apple-darwin',
      key: 'a'.repeat(64),
    };
    const result = await cachedV8({ ...options, build: async () => built });
    await rm(archive);
    await rm(binding);
    const reuse = () =>
      cachedV8({ ...options, build: () => assert.fail('cache hit must skip compilation') });
    assert.deepEqual(await reuse(), result);
    for (const file of [
      'librusty_v8.a',
      'src_binding.rs',
      'THIRD_PARTY_NOTICES.txt',
      'receipt.json',
    ]) {
      const path = join(options.directory, options.key, file);
      const original = await readFile(path);
      await writeFile(path, 'corrupt');
      await assert.rejects(reuse(), /Invalid V8 cache entry/);
      await rm(path);
      await assert.rejects(reuse(), /Invalid V8 cache entry/);
      await writeFile(path, original);
    }
    assert.deepEqual(await reuse(), result);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('failed producers leave no entry and concurrent producers admit one complete bundle', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'maka-v8-admission-'));
  try {
    const options = { directory: stage, target: 'x86_64-pc-windows-msvc', key: 'b'.repeat(64) };
    await assert.rejects(
      cachedV8({
        ...options,
        build: async () => {
          throw new Error('compilation failed');
        },
      }),
      /compilation failed/,
    );
    assert.deepEqual(await readdir(stage), []);
    const source = await mkdtemp(join(stage, 'source-'));
    const archive = join(source, 'built.lib');
    const binding = join(source, 'built.rs');
    await writeFile(archive, 'native archive');
    await writeFile(binding, 'matching bindings');
    const gate = Promise.withResolvers();
    let entered = 0;
    const build = async () => {
      if (++entered === 2) gate.resolve();
      await gate.promise;
      return {
        environment: { RUSTY_V8_ARCHIVE: archive, RUSTY_V8_SRC_BINDING_PATH: binding },
        notices: 'complete V8 notices',
      };
    };
    const [first, second] = await Promise.all([
      cachedV8({ ...options, build }),
      cachedV8({ ...options, build }),
    ]);
    assert.deepEqual(first, second);
    assert.equal(await readFile(first.environment.RUSTY_V8_ARCHIVE, 'utf8'), 'native archive');
    await rm(source, { recursive: true });
    assert.deepEqual(await readdir(stage), [options.key]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
