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

import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sdkRoot = dirname(fileURLToPath(import.meta.url));
const [language, templateValue] = process.argv.slice(2);
if (!language || !templateValue || !['rust', 'c', 'zig'].includes(language)) {
  throw new Error('Usage: node build.mjs <rust|c|zig> <template-directory>');
}

const template = resolve(sdkRoot, templateValue);
const output = join(template, 'dist');
await mkdir(output, { recursive: true });

if (language === 'rust') await buildRust(template, output);
else if (language === 'c') await buildC(template, output);
else await buildZig(template, output);

console.log(`built ${join(output, 'plugin.wasm')}`);

async function buildRust(templateRoot, outputRoot) {
  await run('cargo', [
    'build',
    '--manifest-path',
    join(templateRoot, 'Cargo.toml'),
    '--target',
    'wasm32-unknown-unknown',
    '--release',
  ]);
  const cargoManifest = await readFile(join(templateRoot, 'Cargo.toml'), 'utf8');
  const packageName = cargoManifest.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!packageName) throw new Error(`Cargo package name is missing in ${templateRoot}`);
  await cp(
    join(templateRoot, 'target/wasm32-unknown-unknown/release', `${packageName}.wasm`),
    join(outputRoot, 'plugin.wasm'),
  );
}

async function buildC(templateRoot, outputRoot) {
  const object = join(outputRoot, 'plugin.o');
  await run(process.env.CLANG ?? 'clang', [
    '--target=wasm32-unknown-unknown',
    '-O2',
    '-c',
    join(templateRoot, 'plugin.c'),
    '-I',
    join(sdkRoot, 'c'),
    '-o',
    object,
  ]);
  await run(
    process.env.WASM_LD ?? 'wasm-ld',
    linkerArguments(object, join(outputRoot, 'plugin.wasm')),
  );
}

async function buildZig(templateRoot, outputRoot) {
  await run('zig', [
    'build-exe',
    join(templateRoot, 'src/main.zig'),
    '-target',
    'wasm32-freestanding',
    '-O',
    'ReleaseSmall',
    '-fno-entry',
    '--name',
    'plugin',
    '--export-memory',
    '--export=maka_plugin_manifest_ptr',
    '--export=maka_plugin_manifest_len',
    '--export=maka_plugin_alloc',
    '--export=maka_plugin_free',
    '--export=maka_plugin_invoke',
    '-femit-bin=' + join(outputRoot, 'plugin.wasm'),
  ]);
}

function linkerArguments(object, output) {
  return [
    object,
    '--no-entry',
    '--export-memory',
    '--export=maka_plugin_manifest_ptr',
    '--export=maka_plugin_manifest_len',
    '--export=maka_plugin_alloc',
    '--export=maka_plugin_free',
    '--export=maka_plugin_invoke',
    '--initial-memory=262144',
    '-o',
    output,
  ];
}
