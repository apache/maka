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
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('postinstall reuses installed WASM while applying source-only patches, including a repeat', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-patches-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'patches'));
    mkdirSync(join(root, 'node_modules/run/dist/runtime'), { recursive: true });
    cpSync(
      join(import.meta.dirname, 'apply-dependency-patches.mjs'),
      join(root, 'scripts/apply-dependency-patches.mjs'),
    );
    symlinkSync(
      dirname(createRequire(import.meta.url).resolve('patch-package/package.json')),
      join(root, 'node_modules/patch-package'),
      'dir',
    );
    writeFileSync(join(root, 'package.json'), '{"name":"patch-fixture","version":"1.0.0"}');
    writeFileSync(join(root, 'node_modules/run/package.json'), '{"name":"run","version":"2.1.4"}');
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).toString('base64');
    const source = (payload, code) =>
      `export const INLINE_RUN_WORKER_SOURCE = ${JSON.stringify(`globalThis.__RUN_QUICKJS_WASM_BASE64__ = "${payload}";\n${code}`)};\n`;
    const workerPath = join(root, 'node_modules/run/dist/runtime/worker-source.js');
    writeFileSync(workerPath, source(wasm, 'original'));
    const patch = [
      'diff --git a/node_modules/run/dist/runtime/worker-source.js b/node_modules/run/dist/runtime/worker-source.js',
      '--- a/node_modules/run/dist/runtime/worker-source.js',
      '+++ b/node_modules/run/dist/runtime/worker-source.js',
      '@@ -1 +1 @@',
      `-${source('__MAKA_RUN_WASM_BASE64__', 'original').trimEnd()}`,
      `+${source('__MAKA_RUN_WASM_BASE64__', 'patched').trimEnd()}`,
      '',
    ].join('\n');
    const patchPath = join(root, 'patches/run+2.1.4.patch');
    writeFileSync(patchPath, patch);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, ['scripts/apply-dependency-patches.mjs'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(workerPath, 'utf8'), source(wasm, 'patched'));
      assert.equal(readFileSync(patchPath, 'utf8'), patch);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
