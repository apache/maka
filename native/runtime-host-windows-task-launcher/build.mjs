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

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The Runtime Host Windows task launcher must be built on Windows x64');
}
const encodedRustflags = [
  process.env.CARGO_ENCODED_RUSTFLAGS,
  `--remap-path-prefix=${root}=native/runtime-host-windows-task-launcher`,
  '-Clink-arg=/PDBALTPATH:maka-runtime-host-task-launcher.pdb',
]
  .filter(Boolean)
  .join('\x1f');
await run('cargo', ['build', '--release', '--locked'], root, {
  ...process.env,
  CARGO_ENCODED_RUSTFLAGS: encodedRustflags,
});

const source = join(root, 'target', 'release', 'maka-runtime-host-task-launcher.exe');
const destination = process.env.MAKA_RUNTIME_HOST_WINDOWS_TASK_LAUNCHER_OUTPUT?.trim()
  ? resolve(process.env.MAKA_RUNTIME_HOST_WINDOWS_TASK_LAUNCHER_OUTPUT.trim())
  : source;
if (destination !== source) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
const executable = await readFile(destination);
assertWindowsGuiSubsystem(executable);
if (executable.includes(Buffer.from(root))) {
  throw new Error('The Runtime Host Windows task launcher contains its build path');
}
process.stdout.write(`${destination}\n`);

function assertWindowsGuiSubsystem(executable) {
  const peHeader = executable.readUInt32LE(0x3c);
  const optionalHeader = peHeader + 24;
  if (
    executable.toString('ascii', peHeader, peHeader + 4) !== 'PE\0\0' ||
    ![0x10b, 0x20b].includes(executable.readUInt16LE(optionalHeader)) ||
    executable.readUInt16LE(optionalHeader + 68) !== 2
  ) {
    throw new Error('The Runtime Host task launcher is not a Windows GUI executable');
  }
}

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
