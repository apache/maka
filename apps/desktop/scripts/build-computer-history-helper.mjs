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

import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(desktopRoot, 'native', 'computer-history');
const output = resolve(desktopRoot, 'resources', 'bin', 'open-history');

if (process.platform !== 'darwin') {
  console.log('[computer-history] macOS helper skipped on this platform');
  process.exit(0);
}

await run('swift', ['build', '--package-path', packageRoot, '-c', 'release', '--product', 'open-history']);
await mkdir(dirname(output), { recursive: true });
await copyFile(resolve(packageRoot, '.build', 'release', 'open-history'), output);
console.log(`[computer-history] helper ready: ${output}`);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? code ?? 'unknown'})`));
    });
  });
}
