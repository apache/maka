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
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildComputerHistoryHelper({
  platform = process.platform,
  arch = process.arch,
  root = desktopRoot,
  run = runCommand,
} = {}) {
  if (platform !== 'darwin' && platform !== 'win32') return null;
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error('The Computer History Windows helper must be built on Windows x64');
  }

  const windows = platform === 'win32';
  const packageRoot = resolve(root, 'native', windows ? 'computer-history-windows' : 'computer-history');
  const binaryName = windows ? 'open-history.exe' : 'open-history';
  const output = resolve(root, 'resources', 'bin', binaryName);
  let source;
  if (windows) {
    const target = 'x86_64-pc-windows-msvc';
    const targetDirectory = resolve(packageRoot, 'target');
    await run('cargo', [
      'build',
      '--manifest-path', resolve(packageRoot, 'Cargo.toml'),
      '--package', 'maka-computer-history-windows',
      '--bin', 'open-history',
      '--release',
      '--locked',
      '--target', target,
      '--target-dir', targetDirectory,
    ]);
    source = resolve(targetDirectory, target, 'release', binaryName);
  } else {
    await run('swift', ['build', '--package-path', packageRoot, '-c', 'release', '--product', 'open-history']);
    source = resolve(packageRoot, '.build', 'release', binaryName);
  }
  await mkdir(dirname(output), { recursive: true });
  await copyFile(source, output);
  return output;
}

function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? code ?? 'unknown'})`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = await buildComputerHistoryHelper();
  console.log(output
    ? `[computer-history] helper ready: ${output}`
    : '[computer-history] native helper skipped on this platform');
}
