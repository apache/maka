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

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compareProductReleaseVersions } from './release-version.mjs';
import { sha256File } from './verify-packaged-app.mjs';

const runFile = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultManifestPath = join(repoRoot, 'scripts', 'windows-upgrade-baseline.json');

export function validateWindowsUpgradeBaseline(manifest, candidateVersion) {
  if (manifest.tag !== `v${manifest.version}`)
    throw new Error('Baseline tag must match its version.');
  if (manifest.assetName !== `Maka-${manifest.version}-win-x64.exe`) {
    throw new Error('Baseline asset name must exactly match its version and architecture.');
  }
  if (!/^[0-9a-f]{64}$/u.test(manifest.sha256)) {
    throw new Error('Baseline SHA-256 must be a lowercase 64-character digest.');
  }
  if (compareProductReleaseVersions(manifest.version, candidateVersion) >= 0) {
    throw new Error('Windows upgrade baseline must be older than the candidate.');
  }
  return manifest;
}

export async function prepareWindowsUpgradeBaseline(
  candidateVersion,
  outputDirectory,
  {
    manifestPath = defaultManifestPath,
    repository = process.env.GITHUB_REPOSITORY ?? 'apache/maka',
    run = runFile,
    checksum = sha256File,
  } = {},
) {
  const manifest = validateWindowsUpgradeBaseline(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    candidateVersion,
  );
  const directory = resolve(outputDirectory);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await run('gh', [
    'release',
    'download',
    manifest.tag,
    '--repo',
    repository,
    '--pattern',
    manifest.assetName,
    '--dir',
    directory,
  ]);
  const installer = join(directory, manifest.assetName);
  const actual = await checksum(installer);
  if (actual !== manifest.sha256) {
    throw new Error(
      `Windows upgrade baseline checksum mismatch for ${basename(installer)}: expected ${manifest.sha256}, found ${actual}.`,
    );
  }
  return installer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const installer = await prepareWindowsUpgradeBaseline(process.argv[2], process.argv[3]);
  process.stdout.write(installer);
}
