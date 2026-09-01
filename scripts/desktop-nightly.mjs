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

import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyDesktopUpdateArtifacts } from './desktop-update-contract.mjs';
import { assertProductNightlyVersion } from './release-version.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function assertDesktopNightlyVersion(version, productVersion) {
  return assertProductNightlyVersion(version, productVersion);
}

export function resolveDesktopBuildVersion(productVersion, environment = process.env) {
  const nightlyVersion = environment.MAKA_DESKTOP_NIGHTLY_VERSION?.trim();
  return nightlyVersion
    ? assertDesktopNightlyVersion(nightlyVersion, productVersion)
    : productVersion;
}

export function resolveRuntimeHostSetupPackage(productVersion, environment = process.env) {
  return `maka-agent@${resolveDesktopBuildVersion(productVersion, environment)}`;
}

export function desktopNightlyReleaseAssetNames(version) {
  const names = nightlyArtifactNames(version);
  return [
    names.macDmg,
    names.macZip,
    `${names.macZip}.blockmap`,
    names.windowsExe,
    `${names.windowsExe}.blockmap`,
    names.windowsZip,
    `Maka-${version}-attestation.sigstore.json`,
    'dev-mac.yml',
    'dev.yml',
  ].sort();
}

function nightlyArtifactNames(version) {
  return {
    macZip: `Maka-${version}-mac-arm64.zip`,
    macDmg: `Maka-${version}-mac-arm64.dmg`,
    windowsExe: `Maka-${version}-win-x64.exe`,
    windowsZip: `Maka-${version}-win-x64.zip`,
  };
}

export async function stageDesktopNightly({ inputDirectory, outputDirectory, version }) {
  const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assertDesktopNightlyVersion(version, productManifest.version);
  const names = nightlyArtifactNames(version);
  const payloads = [
    names.macDmg,
    names.macZip,
    `${names.macZip}.blockmap`,
    names.windowsExe,
    `${names.windowsExe}.blockmap`,
    names.windowsZip,
  ];
  const metadataNames = ['dev-mac.yml', 'dev.yml'];
  const expected = [...payloads, ...metadataNames].sort();
  const actual = (await readdir(inputDirectory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Desktop Nightly input is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }

  await Promise.all([
    verifyDesktopUpdateArtifacts({
      directory: inputDirectory,
      metadataName: 'dev-mac.yml',
      version,
      artifactName: names.macZip,
    }),
    verifyDesktopUpdateArtifacts({
      directory: inputDirectory,
      metadataName: 'dev.yml',
      version,
      artifactName: names.windowsExe,
    }),
  ]);

  await rm(outputDirectory, { recursive: true, force: true });
  const releaseDirectory = join(outputDirectory, 'release');
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all(
    [...payloads, ...metadataNames].map(async (name) => {
      const source = join(inputDirectory, name);
      const info = await stat(source);
      if (!info.isFile()) throw new Error(`Desktop Nightly payload is not a file: ${source}`);
      await copyFile(source, join(releaseDirectory, name));
    }),
  );
}

export async function addDesktopNightlyAttestation({ outputDirectory, version, bundlePath }) {
  const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assertDesktopNightlyVersion(version, productManifest.version);
  const details = await stat(bundlePath);
  if (!details.isFile() || details.size === 0) {
    throw new Error('Desktop Nightly attestation must be a non-empty regular file');
  }
  const name = `Maka-${version}-attestation.sigstore.json`;
  await copyFile(bundlePath, join(outputDirectory, 'release', name));
  return name;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'stage' && rest.length === 3) {
    const [inputDirectory, outputDirectory, version] = rest;
    await stageDesktopNightly({
      inputDirectory,
      outputDirectory,
      version,
    });
    return;
  }
  if (command === 'add-attestation' && rest.length === 3) {
    const [outputDirectory, version, bundlePath] = rest;
    await addDesktopNightlyAttestation({ outputDirectory, version, bundlePath });
    return;
  }
  throw new Error(
    'usage: desktop-nightly.mjs stage <input-directory> <output-directory> <version> | add-attestation <output-directory> <version> <bundle-path>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
