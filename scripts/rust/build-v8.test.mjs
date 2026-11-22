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
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildV8, prepareV8SourceDir } from './build-v8.mjs';

test('prepareV8SourceDir keeps caller directory on non-Windows', async () => {
  const result = await prepareV8SourceDir('/tmp/maka-nightly-build-abc/v8', {
    platform: 'linux',
    mkdtempFn: () => assert.fail('must not allocate drive-root dir on non-Windows'),
  });
  assert.equal(result.directory, '/tmp/maka-nightly-build-abc/v8');
  await result.cleanup();
});

test('prepareV8SourceDir allocates and cleans up a drive-root temp dir on Windows', async () => {
  let createdPrefix = null;
  let removed = null;
  const result = await prepareV8SourceDir('/tmp/maka-nightly-build-abc/v8', {
    platform: 'win32',
    mkdtempFn: async (prefix) => {
      createdPrefix = prefix;
      return prefix + 'xyz';
    },
    rmFn: async (dir) => {
      removed = dir;
    },
  });
  assert.ok(createdPrefix.endsWith('v8-'), 'unexpected prefix: ' + createdPrefix);
  assert.equal(result.directory, createdPrefix + 'xyz');
  await result.cleanup();
  assert.equal(removed, createdPrefix + 'xyz');
});

test('prepareV8SourceDir falls back to caller directory when drive root is not writable', async () => {
  const result = await prepareV8SourceDir('/tmp/maka-nightly-build-abc/v8', {
    platform: 'win32',
    mkdtempFn: async () => {
      const err = new Error('permission denied');
      err.code = 'EPERM';
      throw err;
    },
  });
  assert.equal(result.directory, '/tmp/maka-nightly-build-abc/v8');
  await result.cleanup();
});

test('buildV8 keeps short temp outputs alive until cache admission completes, then cleans up', async () => {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const source = JSON.parse(await readFile(join(repoRoot, 'scripts/rust/v8-source.json'), 'utf8'));
  const metadata = {
    packages: [{ id: 'v8-pkg', name: 'v8', version: source.version }],
    resolve: { nodes: [{ id: 'v8-pkg', features: ['default', 'test-unpinned-feature'] }] },
  };
  const scratch = await mkdtemp(join(tmpdir(), 'maka-build-v8-test-'));
  let allocatedDir = null;
  try {
    const cacheDir = join(scratch, 'cache');
    const result = await buildV8({
      root: repoRoot,
      directory: join(scratch, 'long-work-dir', 'v8'),
      cache: cacheDir,
      target: 'x86_64-pc-windows-msvc',
      env: {},
      metadata,
      prepareSourceDir: (dir) =>
        prepareV8SourceDir(dir, {
          platform: 'win32',
          mkdtempFn: async () => {
            allocatedDir = await mkdtemp(join(scratch, 'v8-'));
            return allocatedDir;
          },
        }),
      compile: async ({ directory }) => {
        const archive = join(directory, 'rusty_v8.lib');
        const binding = join(directory, 'src_binding.rs');
        await writeFile(archive, 'fake-win-v8-archive');
        await writeFile(binding, 'pub const BINDING: usize = 1;');
        return {
          environment: { RUSTY_V8_ARCHIVE: archive, RUSTY_V8_SRC_BINDING_PATH: binding },
          notices: 'Apache-2.0 test notices\n',
        };
      },
    });
    assert.ok(allocatedDir);
    assert.equal(
      await readFile(result.environment.RUSTY_V8_ARCHIVE, 'utf8'),
      'fake-win-v8-archive',
    );
    assert.equal(
      await readFile(result.environment.RUSTY_V8_SRC_BINDING_PATH, 'utf8'),
      'pub const BINDING: usize = 1;',
    );
    await assert.rejects(stat(allocatedDir), { code: 'ENOENT' });

    let failedAllocatedDir = null;
    await assert.rejects(
      buildV8({
        root: repoRoot,
        directory: join(scratch, 'long-work-dir', 'v8'),
        cache: join(scratch, 'cache-fail'),
        target: 'x86_64-pc-windows-msvc',
        env: {},
        metadata,
        prepareSourceDir: (dir) =>
          prepareV8SourceDir(dir, {
            platform: 'win32',
            mkdtempFn: async () => {
              failedAllocatedDir = await mkdtemp(join(scratch, 'v8-fail-'));
              return failedAllocatedDir;
            },
          }),
        compile: async () => {
          throw new Error('simulated compile failure');
        },
      }),
      /simulated compile failure/,
    );
    assert.ok(failedAllocatedDir);
    await assert.rejects(stat(failedAllocatedDir), { code: 'ENOENT' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
