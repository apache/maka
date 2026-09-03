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

import { access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDesktopReleaseTarget } from './desktop-nightly.mjs';
import { desktopReleaseTargets } from './desktop-release-targets.mjs';
import {
  bumpedAutoupdateVersion,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';
import { runCommand } from './verify-packaged-app.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');

/** Builds only the signed ZIP needed to prove the candidate's next update. */
export async function packageMacosAutoupdateNext({
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
  env = process.env,
} = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('The macOS auto-update build requires an Apple Silicon macOS host.');
  }
  const candidate = await resolveDesktopReleaseTarget('macos-arm64', { environment: env });
  const nextVersion = bumpedAutoupdateVersion(candidate.version);
  const outputDirectory = join(desktopRoot, 'release-autoupdate-next');
  // The bumped build is the same target under a different version, so its ZIP is
  // named by the same descriptor the candidate's is.
  const zipName = desktopReleaseTargets(nextVersion, { nightly: false })
    .find((entry) => entry.name === 'macos-arm64')
    .payloads.find((name) => name.endsWith('.zip'));

  await access(join(desktopRoot, 'dist'));
  await access(candidate.payloadPath('.zip'));
  await rm(outputDirectory, { recursive: true, force: true });

  const args = [
    '--workspace',
    '@maka/desktop',
    'exec',
    '--',
    'electron-builder',
    '--config',
    'electron-builder.config.mjs',
    '--mac',
    'zip',
    '--arm64',
    '--publish',
    'never',
    `-c.extraMetadata.version=${nextVersion}`,
    '-c.extraMetadata.makaUpdateTestProfile=true',
    '-c.mac.notarize=false',
    '-c.directories.output=release-autoupdate-next',
  ];
  if (env.MAKA_LOCAL_UPDATE_SIGNING_IDENTITY) {
    args.push(`-c.mac.identity=${env.MAKA_LOCAL_UPDATE_SIGNING_IDENTITY}`);
    args.push('-c.mac.timestamp=none');
    args.push('-c.mac.hardenedRuntime=false');
  }
  await run('npm', args, { cwd: repoRoot, env });

  await verifyDesktopUpdateArtifacts({
    directory: outputDirectory,
    metadataName: 'latest-mac.yml',
    version: nextVersion,
    artifactNames: [zipName],
  });
  await rm(join(outputDirectory, 'mac-arm64'), { recursive: true, force: true });
  return {
    version: nextVersion,
    zipPath: join(outputDirectory, zipName),
    metadataPath: join(outputDirectory, 'latest-mac.yml'),
    blockmapPath: join(outputDirectory, `${zipName}.blockmap`),
    directory: outputDirectory,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await packageMacosAutoupdateNext()));
}
