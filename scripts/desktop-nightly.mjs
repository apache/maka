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
import { desktopPublishedFeeds, desktopReleaseTargets } from './desktop-release-targets.mjs';
import {
  mergeDesktopUpdateFeeds,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';
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

/**
 * The one place a packaging or verification step turns a target name into the
 * files on disk. The version comes from the Desktop manifest and the nightly
 * environment override, the names come from the descriptor, and the directory
 * is the one electron-builder writes into — so no step spells an artifact name,
 * and none of them can disagree about which channel it is building.
 *
 * It lives here rather than beside the descriptor because the descriptor cannot
 * import `resolveDesktopBuildVersion` back out of this module without a cycle.
 */
export async function resolveDesktopReleaseTarget(
  name,
  { environment = process.env, root = repoRoot } = {},
) {
  const desktopRoot = join(root, 'apps', 'desktop');
  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const version = resolveDesktopBuildVersion(manifest.version, environment);
  const nightly = version !== manifest.version;
  const target = desktopReleaseTargets(version, { nightly }).find((entry) => entry.name === name);
  if (!target) {
    throw new Error(`Unknown Desktop release target ${name}.`);
  }
  const releaseDirectory = join(desktopRoot, 'release');
  return {
    ...target,
    version,
    nightly,
    releaseDirectory,
    payloadPath(extension) {
      const payload = target.payloads.find((payloadName) => payloadName.endsWith(extension));
      if (!payload) {
        throw new Error(`Target ${name} ships no ${extension} payload.`);
      }
      return join(releaseDirectory, payload);
    },
    checksumPaths() {
      return target.checksums.map((checksumName) => join(releaseDirectory, checksumName));
    },
  };
}

export function desktopNightlyTargets(version) {
  return desktopReleaseTargets(version, { nightly: true });
}

function desktopNightlyPublishedFeeds(version) {
  return desktopPublishedFeeds(version, { nightly: true });
}

/** Everything the provenance attestation covers: the assets minus the bundle. */
export function desktopNightlyAttestedAssetNames(version) {
  return [
    ...desktopNightlyTargets(version).flatMap((target) => target.payloads),
    ...desktopNightlyPublishedFeeds(version).map((feed) => feed.name),
  ].sort();
}

export function desktopNightlyReleaseAssetNames(version) {
  return [
    ...desktopNightlyAttestedAssetNames(version),
    `Maka-${version}-attestation.sigstore.json`,
  ].sort();
}

/**
 * Collects one packaging runner's uploads out of the build directory. The
 * runner never names its own files: the target descriptor is the single place
 * that knows what a target produces.
 */
export async function stageDesktopNightlyTarget({
  targetName,
  releaseDirectory,
  stageDirectory,
  version,
}) {
  const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assertDesktopNightlyVersion(version, productManifest.version);
  const target = desktopNightlyTargets(version).find((entry) => entry.name === targetName);
  if (!target) {
    throw new Error(`Unknown Desktop Nightly target: ${targetName}`);
  }
  await mkdir(stageDirectory, { recursive: true });
  const staged = [...target.payloads, target.feed];
  await Promise.all(
    staged.map(async (name) => {
      const sourcePath = join(releaseDirectory, name);
      const info = await stat(sourcePath);
      if (!info.isFile()) {
        throw new Error(`Desktop Nightly payload is not a file: ${sourcePath}`);
      }
      await copyFile(sourcePath, join(stageDirectory, name));
    }),
  );
  return staged;
}

export async function stageDesktopNightly({ inputDirectory, outputDirectory, version }) {
  const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assertDesktopNightlyVersion(version, productManifest.version);
  const targets = desktopNightlyTargets(version);
  const feeds = desktopNightlyPublishedFeeds(version);
  const payloads = targets.flatMap((target) => target.payloads);
  const expected = [...payloads, ...targets.map((target) => target.feed)].sort();
  const actual = (await readdir(inputDirectory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Desktop Nightly input is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }

  await rm(outputDirectory, { recursive: true, force: true });
  const releaseDirectory = join(outputDirectory, 'release');
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all(
    payloads.map(async (name) => {
      const source = join(inputDirectory, name);
      const info = await stat(source);
      if (!info.isFile()) throw new Error(`Desktop Nightly payload is not a file: ${source}`);
      await copyFile(source, join(releaseDirectory, name));
    }),
  );
  await Promise.all(
    feeds.map(async (feed) => {
      const output = join(releaseDirectory, feed.name);
      if (feed.mergedFrom) {
        await mergeDesktopUpdateFeeds({
          sourcePaths: feed.mergedFrom.map((name) => join(inputDirectory, name)),
          outputPath: output,
        });
        return;
      }
      await copyFile(join(inputDirectory, feed.name), output);
    }),
  );

  // Verify what is about to be published, not what arrived: the macOS feed only
  // becomes whole in the staging directory.
  await Promise.all(
    feeds.map((feed) =>
      verifyDesktopUpdateArtifacts({
        directory: releaseDirectory,
        metadataName: feed.name,
        version,
        artifactNames: feed.advertised,
      }),
    ),
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
  if (command === 'attested-assets' && rest.length === 1) {
    const [version] = rest;
    const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    assertDesktopNightlyVersion(version, productManifest.version);
    process.stdout.write(`${desktopNightlyAttestedAssetNames(version).join('\n')}\n`);
    return;
  }
  if (command === 'stage-target' && rest.length === 4) {
    const [targetName, releaseDirectory, stageDirectory, version] = rest;
    await stageDesktopNightlyTarget({ targetName, releaseDirectory, stageDirectory, version });
    return;
  }
  if (command === 'add-attestation' && rest.length === 3) {
    const [outputDirectory, version, bundlePath] = rest;
    await addDesktopNightlyAttestation({ outputDirectory, version, bundlePath });
    return;
  }
  throw new Error(
    'usage: desktop-nightly.mjs stage <input-directory> <output-directory> <version> | stage-target <target> <release-directory> <stage-directory> <version> | add-attestation <output-directory> <version> <bundle-path>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
