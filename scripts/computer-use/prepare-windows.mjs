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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMakaCuSourceBranch } from './prepare-provenance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const destination = join(repoRoot, 'apps', 'desktop', 'resources', 'bin', 'maka-cu.exe');

function fail(message) {
  process.stderr.write(`computer-use prepare-windows: ${message}\n`);
  process.exit(1);
}

function git(source, args) {
  return execFileSync('git', ['-C', source, ...args], {
    encoding: 'utf8',
  }).trim();
}

function sourcePath() {
  return resolve(process.env.MAKA_CU_SOURCE || join(repoRoot, '..', 'maka-cu'));
}

function sourceBranch(source) {
  const currentBranch = git(source, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteBranches = git(source, [
    'for-each-ref',
    '--points-at',
    'HEAD',
    '--format=%(refname:short)',
    'refs/remotes',
  ]).split('\n');
  return resolveMakaCuSourceBranch({
    currentBranch,
    remoteBranches,
    explicitBranch: process.env.MAKA_CU_SOURCE_BRANCH,
  });
}

function assertPE(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    fail(`${path} is not a PE executable.`);
  }
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.toString('latin1', offset, offset + 4) !== 'PE\0\0') {
    fail(`${path} has no PE signature.`);
  }
  if (bytes.readUInt16LE(offset + 4) !== 0x8664) {
    fail(`${path} is not a Windows x64 executable.`);
  }
}

const source = sourcePath();
const modulePath = join(source, 'apps', 'OpenComputerUseWindows');
if (!existsSync(join(modulePath, 'go.mod'))) {
  fail(`no Windows Go module at ${modulePath}. Set MAKA_CU_SOURCE to the maka-cu checkout.`);
}
const status = git(source, ['status', '--porcelain']);
if (status && process.env.MAKA_CU_ALLOW_DIRTY !== '1') {
  fail(
    `${source} has uncommitted changes, so the recorded commit would not describe the binary. ` +
      'Commit them, or set MAKA_CU_ALLOW_DIRTY=1 for a throwaway build.',
  );
}

mkdirSync(dirname(destination), { recursive: true });
const temporary = `${destination}.tmp`;
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', temporary, '.'], {
  cwd: modulePath,
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  stdio: 'inherit',
});
assertPE(temporary);
copyFileSync(temporary, destination);
rmSync(temporary, { force: true });
const binarySha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.makaCu = {
  repo: 'maka-agent/maka-cu',
  branch: sourceBranch(source),
  commit: git(source, ['rev-parse', 'HEAD']),
  expectedProtocolVersion: 'maka.cu/2',
  binaryName: 'maka-cu.exe',
  platform: 'win32',
  arch: 'x64',
  binarySizeBytes: statSync(destination).size,
  binarySha256,
  buildProvenance: 'local-source-build',
  signature: 'none',
  distributionReady: false,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

process.stderr.write(
  `computer-use prepare-windows: ${destination}\n` +
    `computer-use prepare-windows: sha256 ${binarySha256}\n` +
    'computer-use prepare-windows: development only; packaged Windows builds remain disabled until Authenticode provenance is verified.\n',
);
