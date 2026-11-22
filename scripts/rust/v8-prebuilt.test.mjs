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
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildV8 } from './build-v8.mjs';
import { cachedV8, v8CacheKey } from './v8-cache.mjs';
import { packV8 } from './v8-prebuilt.mjs';

test('source-pinned V8 downloads validate before admission and remain usable offline', async (t) => {
  const stage = await mkdtemp(join(tmpdir(), 'maka v8 prebuilt '));
  const server = createServer((_, response) => {
    response.writeHead(status);
    response.end(served);
  });
  let status = 200;
  let served;
  const originalFetch = globalThis.fetch;
  let fetchMock;
  let spawnMock;
  try {
    const source = JSON.parse(await readFile(new URL('./v8-source.json', import.meta.url)));
    const target = 'aarch64-apple-darwin';
    const features = ['simdutf', 'use_custom_libcxx'];
    const key = await v8CacheKey({ source, target, features });
    const root = join(stage, 'source');
    await mkdir(join(root, 'scripts/rust'), { recursive: true });
    await writeFile(join(root, 'scripts/rust/v8-source.json'), JSON.stringify(source));
    const manifest = join(root, 'scripts/rust/v8-prebuilts.json');
    const metadata = {
      packages: [{ id: 'v8', name: 'v8', version: source.version }],
      resolve: { nodes: [{ id: 'v8', features }] },
    };
    const archive = join(stage, 'built.a');
    const binding = join(stage, 'built.rs');
    await writeFile(archive, 'native archive');
    await writeFile(binding, 'matching bindings');
    await cachedV8({
      directory: join(stage, 'producer'),
      key,
      target,
      build: async () => ({
        environment: { RUSTY_V8_ARCHIVE: archive, RUSTY_V8_SRC_BINDING_PATH: binding },
        notices: 'complete V8 notices',
      }),
    });
    const packed = await packV8({
      directory: join(stage, 'producer'),
      key,
      target,
      output: join(stage, 'export'),
    });
    const valid = await readFile(join(stage, 'export', packed.archive));
    served = valid;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const url = 'https://prebuilt.example.invalid/' + packed.archive;
    fetchMock = t.mock.method(globalThis, 'fetch', (requested, options) => {
      assert.equal(requested, url);
      return originalFetch(origin, options);
    });
    spawnMock = t.mock.method(childProcess, 'spawn', () => {
      throw new Error('source build selected');
    });
    syncBuiltinESMExports();
    const pin = (bytes) => ({ url, sha256: createHash('sha256').update(bytes).digest('hex') });
    let attempt = 0;
    const invoke = (cache) =>
      buildV8({
        root,
        target,
        metadata,
        env: {},
        cache,
        directory: join(stage, 'attempt-' + attempt++),
      });
    await writeFile(manifest, JSON.stringify({ [key]: pin(valid) }));
    const cache = join(stage, 'consumer');
    const result = await invoke(cache);
    assert.equal(await readFile(result.environment.RUSTY_V8_ARCHIVE, 'utf8'), 'native archive');
    assert.equal(
      await readFile(result.environment.RUSTY_V8_SRC_BINDING_PATH, 'utf8'),
      'matching bindings',
    );
    assert.equal(result.notices, 'complete V8 notices');
    status = 503;
    assert.deepEqual(await invoke(cache), result);
    await assert.rejects(invoke(join(stage, 'unavailable')), /HTTP 503/);
    await assert.rejects(stat(join(stage, 'unavailable', key)), { code: 'ENOENT' });
    status = 200;

    const tar = gunzipSync(valid);
    const changedReceipt = Buffer.from(tar);
    const position = changedReceipt.indexOf(key);
    assert.ok(position >= 0);
    changedReceipt.write('0'.repeat(64), position);
    const changedPayload = Buffer.from(tar);
    changedPayload[512] ^= 1;
    const traversal = Buffer.from(tar);
    traversal.fill(0, 0, 100);
    traversal.write('../outside', 0);
    checksum(traversal);
    const symlinkHeader = Buffer.from(tar.subarray(0, 512));
    const size = Number.parseInt(symlinkHeader.toString('ascii', 124, 136), 8);
    symlinkHeader.write('00000000000\0', 124);
    symlinkHeader.write('2', 156);
    symlinkHeader.write('../outside\0', 157);
    const symlink = Buffer.concat([symlinkHeader, tar.subarray(512 + Math.ceil(size / 512) * 512)]);
    checksum(symlink);
    const outside = join(stage, 'outside');
    await writeFile(outside, 'untouched');
    for (const [bytes, wrongPin, expected] of [
      [valid, true, /SHA-256 mismatch/],
      [gzipSync(changedReceipt), false, /Invalid V8 cache entry/],
      [gzipSync(changedPayload), false, /Invalid V8 cache entry/],
      [gzipSync(traversal), false, /unexpected archive entries/],
      [gzipSync(symlink), false, /regular files/],
    ]) {
      served = bytes;
      await writeFile(
        manifest,
        JSON.stringify({
          [key]: { ...pin(bytes), ...(wrongPin ? { sha256: '0'.repeat(64) } : {}) },
        }),
      );
      const rejected = join(stage, 'rejected-' + attempt);
      await assert.rejects(invoke(rejected), expected);
      await assert.rejects(stat(join(rejected, key)), { code: 'ENOENT' });
      assert.equal(await readFile(outside, 'utf8'), 'untouched');
    }
    for (const invalid of [null, false]) {
      await writeFile(manifest, JSON.stringify({ [key]: invalid }));
      await assert.rejects(invoke(join(stage, 'invalid-' + invalid)), /Invalid V8 prebuilt pin/);
    }
    await writeFile(manifest, '{}');
    await assert.rejects(invoke(join(stage, 'missing-pin')), /source build selected/);
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(await invoke(cache), result);
  } finally {
    fetchMock?.mock.restore();
    spawnMock?.mock.restore();
    syncBuiltinESMExports();
    server.closeAllConnections();
    server.close();
    await rm(stage, { recursive: true, force: true });
  }
});

function checksum(tar) {
  tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
}
