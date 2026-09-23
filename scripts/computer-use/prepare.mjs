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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const version = '0.28.2';
const archiveName = `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`;
const archiveSha256 = '386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa';
const binarySha256 = 'af30d29cf33bd3bbda1330be7225b18881ea4c5af6df374e08627914b5ac334d';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = join(repoRoot, 'apps/desktop/bundled-tools.json');
const destination = join(repoRoot, 'apps/desktop/resources/bin/cua-driver');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

if (process.platform !== 'darwin') throw new Error('Cua Driver preparation is macOS-only');

const staging = await mkdtemp(join(tmpdir(), 'maka-cua-driver-'));
try {
  const archive = join(staging, archiveName);
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${archiveName}`;
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`Cua Driver download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  if (sha256(await readFile(archive)) !== archiveSha256)
    throw new Error('Cua Driver archive digest mismatch');
  run('tar', ['-xzf', archive, '-C', staging, 'cua-driver']);
  const extracted = join(staging, 'cua-driver');
  if (sha256(await readFile(extracted)) !== binarySha256)
    throw new Error('Cua Driver binary digest mismatch');
  const signature = run('codesign', ['-dv', '--verbose=4', extracted]);
  run('codesign', ['--verify', '--strict', extracted]);
  if (
    !signature.includes('TeamIdentifier=YCK386LBJ7') ||
    !signature.includes('Authority=Developer ID Application: Cua AI, Inc. (YCK386LBJ7)') ||
    !/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(signature)
  ) {
    throw new Error('Cua Driver lacks the pinned Developer ID and hardened-runtime signature');
  }
  if (!run(extracted, ['--version']).includes(`cua-driver ${version}`)) {
    throw new Error('Cua Driver version mismatch');
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(extracted, destination);
  await chmod(destination, 0o755);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.cuaDriver = {
    repo: 'trycua/cua',
    release: `cua-driver-rs-v${version}`,
    archiveName,
    archiveSha256,
    binaryName: 'cua-driver',
    binarySha256,
    teamIdentifier: 'YCK386LBJ7',
    signature: 'developer-id',
    hardenedRuntime: true,
    distributionReady: false,
  };
  delete manifest.makaCu;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`Cua Driver ${version} prepared and verified: ${destination}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
