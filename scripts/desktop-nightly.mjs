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

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyDesktopUpdateArtifacts } from './desktop-update-contract.mjs';
import { assertProductNightlyAdvances, assertProductNightlyVersion } from './release-version.mjs';

export const DESKTOP_NIGHTLY_FEED_URL = 'https://nightlies.apache.org/maka/desktop/';
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

export async function assertDesktopNightlyFeedAdvance({
  directory,
  candidateVersion,
  productVersion,
}) {
  const { parse } = await import('yaml');
  for (const name of ['latest-mac.yml', 'latest.yml']) {
    let source;
    try {
      source = await readFile(join(directory, name), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const currentVersion = parse(source)?.version;
    if (typeof currentVersion !== 'string') {
      throw new Error(`Desktop Nightly feed ${name} has no valid version`);
    }
    assertProductNightlyAdvances(candidateVersion, currentVersion, productVersion);
  }
  return candidateVersion;
}

function nightlyArtifactNames(version) {
  return {
    macZip: `Maka-${version}-mac-arm64.zip`,
    macDmg: `Maka-${version}-mac-arm64.dmg`,
    windowsExe: `Maka-${version}-win-x64.exe`,
    windowsZip: `Maka-${version}-win-x64.zip`,
  };
}

async function rewriteNightlyMetadata(source, destination, version) {
  const { parse, stringify } = await import('yaml');
  const metadata = parse(await readFile(source, 'utf8'));
  const prefix = `versions/${version}/`;
  metadata.path = `${prefix}${metadata.path}`;
  metadata.files = metadata.files.map((file) => ({
    ...file,
    url: `${prefix}${file.url}`,
  }));
  await writeFile(destination, stringify(metadata), 'utf8');
}

function nightlyIndex(version, sourceCommit, names) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Maka Desktop Nightly</title></head>
<body>
<main>
<h1>Maka Desktop Nightly</h1>
<p><strong>Desktop Nightly is a developer snapshot, not an Apache release.</strong> It may be unstable and its files are temporary.</p>
<p>Version <code>${version}</code>, built from source commit <code>${sourceCommit}</code>.</p>
<ul>
<li><a href="versions/${version}/${names.macDmg}">Download for macOS arm64</a></li>
<li><a href="versions/${version}/${names.windowsExe}">Download for Windows x64</a> (unsigned preview)</li>
</ul>
<p>Installed Nightly builds update automatically from this channel.</p>
</main>
</body>
</html>
`;
}

export async function stageDesktopNightly({
  inputDirectory,
  outputDirectory,
  version,
  sourceCommit,
}) {
  const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assertDesktopNightlyVersion(version, productManifest.version);
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('Desktop Nightly requires an exact source commit');
  }
  const names = nightlyArtifactNames(version);
  const payloads = [
    names.macDmg,
    names.macZip,
    `${names.macZip}.blockmap`,
    names.windowsExe,
    `${names.windowsExe}.blockmap`,
    names.windowsZip,
  ];
  const metadataNames = ['latest-mac.yml', 'latest.yml'];
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
      metadataName: 'latest-mac.yml',
      version,
      artifactName: names.macZip,
    }),
    verifyDesktopUpdateArtifacts({
      directory: inputDirectory,
      metadataName: 'latest.yml',
      version,
      artifactName: names.windowsExe,
    }),
  ]);

  await rm(outputDirectory, { recursive: true, force: true });
  const versionDirectory = join(outputDirectory, 'versions', version);
  const feedDirectory = join(outputDirectory, 'feed');
  await Promise.all([
    mkdir(versionDirectory, { recursive: true }),
    mkdir(feedDirectory, { recursive: true }),
  ]);
  await Promise.all(
    payloads.map(async (name) => {
      const source = join(inputDirectory, name);
      const info = await stat(source);
      if (!info.isFile()) throw new Error(`Desktop Nightly payload is not a file: ${source}`);
      await copyFile(source, join(versionDirectory, name));
    }),
  );
  await Promise.all([
    rewriteNightlyMetadata(
      join(inputDirectory, 'latest-mac.yml'),
      join(feedDirectory, 'latest-mac.yml'),
      version,
    ),
    rewriteNightlyMetadata(
      join(inputDirectory, 'latest.yml'),
      join(feedDirectory, 'latest.yml'),
      version,
    ),
  ]);
  await writeFile(join(feedDirectory, 'index.html'), nightlyIndex(version, sourceCommit, names));
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'stage' && rest.length === 4) {
    const [inputDirectory, outputDirectory, version, sourceCommit] = rest;
    await stageDesktopNightly({
      inputDirectory,
      outputDirectory,
      version,
      sourceCommit,
    });
    return;
  }
  if (command === 'assert-feed-advance' && rest.length === 2) {
    const [directory, candidateVersion] = rest;
    const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    await assertDesktopNightlyFeedAdvance({
      directory,
      candidateVersion,
      productVersion: productManifest.version,
    });
    return;
  }
  throw new Error(
    'usage: desktop-nightly.mjs stage <input-directory> <output-directory> <version> <source-commit> | assert-feed-advance <feed-directory> <candidate-version>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
