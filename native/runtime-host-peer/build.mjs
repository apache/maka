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

import { copyFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const encodedRustflags = [
  process.env.CARGO_ENCODED_RUSTFLAGS,
  `--remap-path-prefix=${root}=native/runtime-host-peer`,
  ...(process.platform === 'win32' ? ['-Clink-arg=/PDBALTPATH:maka_runtime_host_peer.pdb'] : []),
]
  .filter(Boolean)
  .join('\x1f');
await run('cargo', ['build', '--release', '--locked'], root, {
  ...process.env,
  CARGO_ENCODED_RUSTFLAGS: encodedRustflags,
});

const library =
  process.platform === 'win32'
    ? 'maka_runtime_host_peer.dll'
    : process.platform === 'darwin'
      ? 'libmaka_runtime_host_peer.dylib'
      : 'libmaka_runtime_host_peer.so';
const destination = join(root, 'target', 'release', 'maka_runtime_host_peer.node');
await copyFile(join(root, 'target', 'release', library), destination);
if (process.platform === 'darwin') {
  await run('install_name_tool', ['-id', '@rpath/maka_runtime_host_peer.node', destination], root, {
    ...process.env,
  });
  await run('strip', ['-x', destination], root, { ...process.env });
} else if (process.platform === 'linux') {
  await run('strip', ['--strip-unneeded', destination], root, { ...process.env });
}
if ((await readFile(destination)).includes(Buffer.from(root))) {
  throw new Error('The Runtime Host peer addon contains its build path');
}
process.stdout.write(`${destination}\n`);

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed: ${signal ?? code}`));
    });
  });
}
