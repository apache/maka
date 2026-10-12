#!/usr/bin/env node
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

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const clang = process.env.CLANG ?? 'clang';
const wasmLd = process.env.WASM_LD ?? 'wasm-ld';
const build = join(root, 'dist');
const object = join(build, 'plugin.o');
const wasm = join(build, 'plugin.wasm');

await mkdir(build, { recursive: true });
await run(clang, [
  '--target=wasm32-unknown-unknown',
  '-O2',
  '-c',
  join(root, 'plugin.ll'),
  '-o',
  object,
]);
await run(wasmLd, [
  object,
  '--no-entry',
  '--export-memory',
  '--export=maka_plugin_manifest_ptr',
  '--export=maka_plugin_manifest_len',
  '--export=maka_plugin_alloc',
  '--export=maka_plugin_free',
  '--export=maka_plugin_invoke',
  '--initial-memory=131072',
  '-o',
  wasm,
]);
console.log(`built ${wasm}`);
