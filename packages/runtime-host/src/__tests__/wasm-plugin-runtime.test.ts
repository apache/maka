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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WasmPluginRuntime, createWasmPluginPackage } from '../server/wasm-plugin-runtime.js';
import { decodeExtensionPackageManifest } from '../server/extension-package-manifest.js';
import { TrustedPluginPackageLoader } from '../server/plugin-package-loader.js';
import type { PluginPackageStore } from '../server/plugin-package-store.js';

test('loads the versioned Wasm tool ABI in an isolated worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-wasm-plugin-'));
  try {
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot);
    const entry = join(packageRoot, 'plugin.wasm');
    await writeFile(entry, fixtureWasm());
    const runtime = await WasmPluginRuntime.load(entry, 'llvm-echo');
    try {
      assert.equal(runtime.manifest.abiVersion, 1);
      assert.equal(runtime.manifest.contributions[0]?.tool.name, 'llvm_echo');
      assert.deepEqual(
        await runtime.invoke('echo', { value: 'hello' }, new AbortController().signal),
        { from: 'wasm' },
      );
      assert.equal(createWasmPluginPackage(runtime).packageId, 'llvm-echo');
    } finally {
      await runtime.close();
    }
    const manifest = decodeExtensionPackageManifest({
      schemaVersion: 1,
      id: 'llvm-echo',
      runtime: {
        entry: 'plugin.wasm',
        format: 'wasm',
        abi: 'maka:plugin/runtime@1',
        llvm: { major: 18 },
      },
    });
    const loader = new TrustedPluginPackageLoader(join(root, 'control'), {} as PluginPackageStore);
    const pkg = await loader.loadInstalled({
      extensionId: 'llvm-echo',
      contentDigest: 'sha256-test',
      root: packageRoot,
      entry,
      manifest,
    });
    assert.equal(pkg.packageId, 'llvm-echo');
    await loader.release(pkg);
    await loader.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureWasm(): Uint8Array {
  const manifest =
    '{"abiVersion":1,"packageId":"llvm-echo","contributions":[{"id":"echo","kind":"tool","tool":{"name":"llvm_echo","description":"LLVM IR tool","parameters":{"type":"object"}}}]}';
  const result = '{"from":"wasm"}';
  const manifestPtr = 1024;
  const resultPtr = 2048;
  const packedResult = (BigInt(resultPtr) << 32n) | BigInt(result.length);
  const section = (id: number, payload: number[]): number[] => [
    id,
    ...uleb(payload.length),
    ...payload,
  ];
  const name = (value: string): number[] => [
    ...uleb(value.length),
    ...Array.from(Buffer.from(value, 'utf8')),
  ];
  const funcType = (params: number[], results: number[]): number[] => [
    0x60,
    ...uleb(params.length),
    ...params,
    ...uleb(results.length),
    ...results,
  ];
  const types = section(1, [
    ...uleb(5),
    ...funcType([], [0x7f]),
    ...funcType([], [0x7e]),
    ...funcType([0x7f], [0x7f]),
    ...funcType([0x7f, 0x7f], []),
    ...funcType([0x7f, 0x7f], [0x7e]),
  ]);
  const functions = section(3, [...uleb(5), 0, 0, 2, 3, 4]);
  const memory = section(5, [1, 0, 1]);
  const exports = section(7, [
    ...uleb(6),
    ...name('memory'),
    0x02,
    0,
    ...name('maka_plugin_manifest_ptr'),
    0x00,
    0,
    ...name('maka_plugin_manifest_len'),
    0x00,
    1,
    ...name('maka_plugin_alloc'),
    0x00,
    2,
    ...name('maka_plugin_free'),
    0x00,
    3,
    ...name('maka_plugin_invoke'),
    0x00,
    4,
  ]);
  const code = section(10, [
    ...uleb(5),
    ...body([0x41, ...sleb(manifestPtr), 0x0b]),
    ...body([0x41, ...sleb(manifest.length), 0x0b]),
    ...body([0x41, ...sleb(4096), 0x0b]),
    ...body([0x0b]),
    ...body([0x42, ...sleb(packedResult), 0x0b]),
  ]);
  const data = section(11, [
    ...uleb(2),
    ...dataSegment(manifestPtr, manifest),
    ...dataSegment(resultPtr, result),
  ]);
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...types,
    ...functions,
    ...memory,
    ...exports,
    ...code,
    ...data,
  ]);
}

function body(instructions: number[]): number[] {
  return [...uleb(instructions.length + 1), 0, ...instructions];
}

function dataSegment(pointer: number, value: string): number[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  return [0x00, 0x41, ...sleb(pointer), 0x0b, ...uleb(bytes.length), ...bytes];
}

function uleb(value: number): number[] {
  const output: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    output.push(byte);
  } while (value !== 0);
  return output;
}

function sleb(value: number | bigint): number[] {
  let current = BigInt(value);
  const output: number[] = [];
  let more = true;
  while (more) {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    more = !((current === 0n && (byte & 0x40) === 0) || (current === -1n && (byte & 0x40) !== 0));
    if (more) byte |= 0x80;
    output.push(byte);
  }
  return output;
}
