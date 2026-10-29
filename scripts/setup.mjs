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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmSpawnOptions } from './npm-spawn.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function read(path) {
  return readFile(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function setup(root = repository, env = process.env) {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const patches = await readdir(resolve(root, 'patches')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const inputs = [
    'package.json',
    'package-lock.json',
    'scripts/apply-dependency-patches.mjs',
    ...manifest.workspaces.map((path) => `${path}/package.json`),
    ...patches.filter((path) => path.endsWith('.patch')).map((path) => `patches/${path}`),
  ].sort();
  const fingerprint = digest(
    JSON.stringify([
      process.platform,
      process.arch,
      process.versions.modules,
      ...(await Promise.all(
        inputs.map(async (path) => [path, digest(await readFile(resolve(root, path)))]),
      )),
    ]),
  );
  const receipt = resolve(root, 'node_modules/.maka-setup.json');
  const installedLock = resolve(root, 'node_modules/.package-lock.json');
  const previous = await read(receipt);
  const installed = await read(installedLock);
  if (previous && installed) {
    const expected = Buffer.from(
      JSON.stringify({ fingerprint, installed: digest(installed) }) + '\n',
    );
    if (previous.equals(expected)) return;
  }
  await new Promise((complete, reject) => {
    const child = spawn(
      'npm',
      ['ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'],
      npmSpawnOptions({
        cwd: root,
        env,
        stdio: 'inherit',
        windowsHide: true,
      }),
    );
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 && !signal ? complete() : reject(new Error(`npm ci failed: ${signal ?? code}`)),
    );
  });
  await writeFile(
    receipt,
    JSON.stringify({
      fingerprint,
      installed: digest(await readFile(installedLock)),
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await setup();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
