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

import { access, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand } from './package-windows-x64.mjs';
import {
  bumpedAutoupdateVersion,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');

/**
 * The version the auto-update harness serves as "newer than the candidate".
 * A stable successor keeps the loopback feed independent from prerelease
 * channel behavior: a prerelease advances to its stable core, while a stable
 * candidate advances to the next patch.
 */
/**
 * Build the version-bumped NSIS installer the auto-update harness serves as
 * the "next" release.
 *
 * Runs only after a full `package:windows-x64`: it reuses the existing
 * workspace build (`apps/desktop/dist`) and injects the bumped version via
 * electron-builder's `extraMetadata`, which rewrites the packaged
 * `package.json` so the upgraded app really reports the new version through
 * `app.getVersion()`. Output goes to a dedicated directory outside
 * `apps/desktop/release`, so the release upload globs can never pick up the
 * fake-versioned artifacts.
 */
export async function packageWindowsAutoupdateNext({
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('The auto-update installer build requires a Windows x64 host.');
  }

  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const nextVersion = bumpedAutoupdateVersion(manifest.version);
  const outputDirectory = join(desktopRoot, 'release-autoupdate-next');
  const exeName = `Maka-${nextVersion}-win-x64.exe`;
  const exePath = join(outputDirectory, exeName);
  const latestYmlPath = join(outputDirectory, 'latest.yml');
  const blockmapPath = join(outputDirectory, `${exeName}.blockmap`);

  // Prerequisites from the full packaging run; failing here beats a confusing
  // electron-builder error half-way through.
  await access(join(desktopRoot, 'dist'));
  await access(join(desktopRoot, 'release', 'win-unpacked'));

  await rm(outputDirectory, { recursive: true, force: true });
  await run('npm', [
    '--workspace',
    '@maka/desktop',
    'exec',
    '--',
    'electron-builder',
    '--config',
    'electron-builder.config.mjs',
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    `-c.extraMetadata.version=${nextVersion}`,
    '-c.directories.output=release-autoupdate-next',
  ]);

  // Assert the properties the harness depends on, not just process exit 0.
  await access(exePath);
  await access(blockmapPath);
  await verifyDesktopUpdateArtifacts({
    directory: outputDirectory,
    metadataName: 'latest.yml',
    version: nextVersion,
    artifactName: exeName,
  });

  return { version: nextVersion, exePath, latestYmlPath, blockmapPath, directory: outputDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await packageWindowsAutoupdateNext();
  console.log(
    JSON.stringify({
      version: result.version,
      exePath: result.exePath,
      directory: result.directory,
    }),
  );
}
