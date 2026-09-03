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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  compareProductReleaseNames,
  productReleaseArtifactRecords,
  verifyProductReleaseArtifactDirectory,
} from './product-release-artifacts.mjs';
import { remoteProductTagCommit } from './product-release-tag.mjs';
import { desktopNightlyReleaseAssetNames } from './desktop-nightly.mjs';
import { parseProductNightlyVersion } from './release-version.mjs';

const execFileAsync = promisify(execFile);

function validateIdentity(version, sourceCommit, repository) {
  parseProductNightlyVersion(version);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('Desktop Nightly source must be an exact commit SHA');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('Desktop Nightly repository must be an exact owner/name');
  }
  return { tag: `v${version}`, version };
}

function notes(version, sourceCommit) {
  return `Developer Snapshot ${version}

This Desktop Nightly was built from ${sourceCommit} for development and testing. It is not an Apache Release and has not been approved by an ASF release vote.

The packaged applications carry the repository DISCLAIMER-WIP and Apache License 2.0 materials. They may be unstable and are not intended as a stable release for general users.`;
}

function snapshotFromView(value) {
  return {
    id: value?.databaseId,
    tag: value?.tagName,
    draft: value?.isDraft,
    prerelease: value?.isPrerelease,
    assets: (value?.assets ?? [])
      .map(({ name, size, digest }) => ({ name, size, digest }))
      .sort((left, right) => compareProductReleaseNames(left.name, right.name)),
  };
}

function snapshotFromRest(value) {
  return {
    id: value?.id,
    tag: value?.tag_name,
    draft: value?.draft,
    prerelease: value?.prerelease,
    assets: (value?.assets ?? [])
      .map(({ name, size, digest }) => ({ name, size, digest }))
      .sort((left, right) => compareProductReleaseNames(left.name, right.name)),
  };
}

function assertReleaseState(release, { tag, draft }) {
  if (!Number.isSafeInteger(release?.id) || release.id < 1 || release.tag !== tag) {
    throw new Error(`GitHub Release does not identify Desktop Nightly ${tag}`);
  }
  if (release.draft !== draft || release.prerelease !== true) {
    throw new Error(`GitHub Release ${tag} must be a ${draft ? 'Draft ' : ''}Prerelease`);
  }
  return release;
}

function assertExactAssets(release, expected) {
  if (JSON.stringify(release.assets) !== JSON.stringify(expected)) {
    throw new Error(`GitHub Desktop Nightly ${release.tag} assets do not match local bytes`);
  }
  return release;
}

function assertAssetSubset(release, expected) {
  const records = new Map(expected.map((record) => [record.name, record]));
  for (const asset of release.assets) {
    if (JSON.stringify(records.get(asset.name)) !== JSON.stringify(asset)) {
      throw new Error(
        `Draft GitHub Desktop Nightly contains unexpected or changed asset ${asset.name}`,
      );
    }
  }
}

async function viewRelease({ repository, tag, cwd, run }) {
  const result = await run(
    'gh',
    [
      'release',
      'view',
      tag,
      '--repo',
      repository,
      '--json',
      'databaseId,tagName,isDraft,isPrerelease,assets',
    ],
    { cwd },
  );
  try {
    return snapshotFromView(JSON.parse(result.stdout));
  } catch (error) {
    throw new Error(`GitHub returned an invalid Desktop Nightly record for ${tag}`, {
      cause: error,
    });
  }
}

function isMissingRelease(error) {
  return /release not found|HTTP 404/u.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);
}

async function localRelease({ artifactDirectory, version }) {
  const names = desktopNightlyReleaseAssetNames(version);
  await verifyProductReleaseArtifactDirectory(artifactDirectory, names);
  return productReleaseArtifactRecords(artifactDirectory, names);
}

async function verifyTag({ cwd, repository, run, sourceCommit, tag }) {
  const remote = await remoteProductTagCommit({ cwd, remote: 'origin', tag, run });
  if (remote !== sourceCommit) {
    throw new Error(
      `Desktop Nightly tag ${tag} points to ${remote ?? 'nothing'} instead of ${sourceCommit}`,
    );
  }
  return repository;
}

export async function prepareDesktopNightlyRelease({
  artifactDirectory,
  repository,
  sourceCommit,
  version,
  cwd = process.cwd(),
  run = execFileAsync,
}) {
  const { tag } = validateIdentity(version, sourceCommit, repository);
  const expected = await localRelease({ artifactDirectory, version });
  await verifyTag({ cwd, repository, run, sourceCommit, tag });
  let release;
  try {
    release = await viewRelease({ repository, tag, cwd, run });
  } catch (error) {
    if (!isMissingRelease(error)) throw error;
    await run(
      'gh',
      [
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--draft',
        '--verify-tag',
        '--prerelease',
        '--latest=false',
        '--title',
        `Maka Desktop Nightly ${version}`,
        '--notes',
        notes(version, sourceCommit),
      ],
      { cwd },
    );
    release = await viewRelease({ repository, tag, cwd, run });
  }
  assertReleaseState(release, { tag, draft: true });
  assertAssetSubset(release, expected);
  await run(
    'gh',
    [
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--draft',
      '--prerelease',
      '--latest=false',
      '--title',
      `Maka Desktop Nightly ${version}`,
      '--notes',
      notes(version, sourceCommit),
    ],
    { cwd },
  );
  const existing = new Set(release.assets.map(({ name }) => name));
  const missing = expected.filter(({ name }) => !existing.has(name));
  if (missing.length > 0) {
    await run(
      'gh',
      [
        'release',
        'upload',
        tag,
        ...missing.map(({ name }) => join(artifactDirectory, name)),
        '--repo',
        repository,
      ],
      { cwd },
    );
  }
  const complete = await viewRelease({ repository, tag, cwd, run });
  assertReleaseState(complete, { tag, draft: true });
  return assertExactAssets(complete, expected);
}

export async function publishDesktopNightlyRelease({
  artifactDirectory,
  repository,
  sourceCommit,
  version,
  cwd = process.cwd(),
  run = execFileAsync,
}) {
  const { tag } = validateIdentity(version, sourceCommit, repository);
  const expected = await localRelease({ artifactDirectory, version });
  await verifyTag({ cwd, repository, run, sourceCommit, tag });
  const draft = assertExactAssets(
    assertReleaseState(await viewRelease({ repository, tag, cwd, run }), { tag, draft: true }),
    expected,
  );
  const response = await run(
    'gh',
    [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/releases/${draft.id}`,
      '-F',
      'draft=false',
      '-F',
      'prerelease=true',
      '-f',
      'make_latest=false',
    ],
    { cwd },
  );
  let published;
  try {
    published = snapshotFromRest(JSON.parse(response.stdout));
  } catch (error) {
    throw new Error(`GitHub returned an invalid Desktop Nightly publication for ${tag}`, {
      cause: error,
    });
  }
  assertExactAssets(assertReleaseState(published, { tag, draft: false }), expected);
  assertExactAssets(
    assertReleaseState(await viewRelease({ repository, tag, cwd, run }), { tag, draft: false }),
    expected,
  );
  return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, artifactDirectory, version, sourceCommit, repository] = process.argv.slice(2);
  const input = { artifactDirectory, version, sourceCommit, repository };
  if (command === 'prepare' && artifactDirectory && version && sourceCommit && repository) {
    await prepareDesktopNightlyRelease(input);
  } else if (command === 'publish' && artifactDirectory && version && sourceCommit && repository) {
    await publishDesktopNightlyRelease(input);
  } else {
    throw new Error(
      'usage: desktop-nightly-release.mjs <prepare|publish> <artifact-directory> <version> <source-commit> <owner/repository>',
    );
  }
}
