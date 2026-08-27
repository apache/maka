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
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseAsfSourceReferenceTag } from './product-release-identity.mjs';
import { parseProductTag, remoteProductTagCommit } from './product-release-tag.mjs';

const execFileAsync = promisify(execFile);

function expectedReleaseIdentity(tag) {
  const { prerelease } = parseProductTag(tag);
  return { tag, isPrerelease: prerelease.length > 0 };
}

export function assertDraftProductRelease(release, tag) {
  const expected = expectedReleaseIdentity(tag);
  if (
    !release ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    release.tag !== expected.tag
  ) {
    throw new Error(`GitHub Release does not identify product tag ${tag}`);
  }
  if (release.draft !== true) {
    throw new Error(`GitHub Release ${tag} must remain a Draft`);
  }
  if (release.prerelease !== expected.isPrerelease) {
    throw new Error(`GitHub Release ${tag} prerelease state must be ${expected.isPrerelease}`);
  }
  return release;
}

export function assertPublishedProductRelease(release, tag) {
  const expected = expectedReleaseIdentity(tag);
  if (!release || release.tag !== tag || release.draft !== false) {
    throw new Error(`GitHub Release ${tag} was not published`);
  }
  if (release.prerelease !== expected.isPrerelease) {
    throw new Error(`GitHub Release ${tag} prerelease state must be ${expected.isPrerelease}`);
  }
  return release;
}

function releaseSnapshotFromGhView(value) {
  return {
    id: value?.databaseId,
    tag: value?.tagName,
    draft: value?.isDraft,
    prerelease: value?.isPrerelease,
    assets: value?.assets ?? [],
  };
}

function releaseSnapshotFromRest(value) {
  return {
    id: value?.id,
    tag: value?.tag_name,
    draft: value?.draft,
    prerelease: value?.prerelease,
    assets: value?.assets ?? [],
  };
}

export function assertProductReleaseWorkflowRun({
  run,
  tag,
  sourceCommit,
  repository,
  runId,
  runAttempt,
}) {
  if (!/^[1-9]\d*$/u.test(String(runId)) || !/^[1-9]\d*$/u.test(String(runAttempt))) {
    throw new Error('Release workflow run ID and attempt must be positive integers');
  }
  const product = parseProductTag(tag);
  const source = parseAsfSourceReferenceTag(run?.head_branch);
  const exact =
    String(run?.id) === String(runId) &&
    String(run?.run_attempt) === String(runAttempt) &&
    run?.path === '.github/workflows/release.yml' &&
    run?.event === 'workflow_dispatch' &&
    run?.status === 'completed' &&
    run?.conclusion === 'success' &&
    run?.head_sha === sourceCommit &&
    run?.head_repository?.full_name === repository &&
    source.version === product.version;
  if (!exact) {
    throw new Error('Release workflow run does not match the approved product source');
  }
  return run;
}

function digestFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function localAssetRecords(directory) {
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Release artifact must be a regular file: ${entry.name}`);
    const path = join(directory, entry.name);
    const [details, digest] = await Promise.all([stat(path), digestFile(path)]);
    records.push({ name: entry.name, size: details.size, digest: `sha256:${digest}` });
  }
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

export async function verifyDraftProductRelease({
  tag,
  sourceCommit,
  repository,
  cwd = process.cwd(),
  run = execFileAsync,
}) {
  expectedReleaseIdentity(tag);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error(`Product source must be an exact commit SHA; found ${sourceCommit}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Product repository must be an exact owner/name; found ${repository}`);
  }

  const remoteCommit = await remoteProductTagCommit({ cwd, remote: 'origin', tag, run });
  if (!remoteCommit) throw new Error(`Product tag ${tag} does not exist on origin`);
  if (remoteCommit !== sourceCommit) {
    throw new Error(`Product tag ${tag} points to ${remoteCommit} instead of ${sourceCommit}`);
  }

  await run('git', ['fetch', '--force', '--no-tags', 'origin', 'main:refs/remotes/origin/main'], {
    cwd,
  });
  await run('git', ['merge-base', '--is-ancestor', sourceCommit, 'refs/remotes/origin/main'], {
    cwd,
  });

  const release = await run(
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
  let parsedRelease;
  try {
    parsedRelease = JSON.parse(release.stdout);
  } catch (error) {
    throw new Error(`GitHub returned an invalid Release record for ${tag}`, { cause: error });
  }
  return assertDraftProductRelease(releaseSnapshotFromGhView(parsedRelease), tag);
}

export async function publishDraftProductRelease({
  tag,
  sourceCommit,
  repository,
  artifactDirectory,
  cwd = process.cwd(),
  run = execFileAsync,
  pause = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const localAssets = await localAssetRecords(artifactDirectory);
  const draft = await verifyDraftProductRelease({ tag, sourceCommit, repository, cwd, run });
  const remoteAssets = (draft.assets ?? [])
    .map(({ name, size, digest }) => ({ name, size, digest }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(remoteAssets) !== JSON.stringify(localAssets)) {
    throw new Error('Draft GitHub Release assets do not match the verified Release run artifacts');
  }

  const isPrerelease = expectedReleaseIdentity(tag).isPrerelease;
  const published = await run(
    'gh',
    [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/releases/${draft.id}`,
      '-F',
      'draft=false',
      '-F',
      `prerelease=${isPrerelease}`,
      '-f',
      `make_latest=${isPrerelease ? 'false' : 'true'}`,
    ],
    { cwd },
  );
  let record;
  try {
    record = releaseSnapshotFromRest(JSON.parse(published.stdout));
  } catch (error) {
    throw new Error(`GitHub returned an invalid publication result for ${tag}`, { cause: error });
  }
  assertPublishedProductRelease(record, tag);

  if (!isPrerelease) {
    let latestTag;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const latest = await run('gh', ['api', `repos/${repository}/releases/latest`], { cwd });
        latestTag = JSON.parse(latest.stdout).tag_name;
      } catch (error) {
        if (attempt === 4) {
          throw new Error('GitHub returned an invalid Latest release record', { cause: error });
        }
      }
      if (latestTag === tag) break;
      if (attempt < 4) await pause(1_000);
    }
    if (latestTag !== tag) {
      throw new Error(`Stable release ${tag} was published but Latest points to ${latestTag}`);
    }
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const usage =
    'usage: product-release-authority.mjs verify-build-run <run-json> <tag> <source-commit> <owner/repository> <run-id> <run-attempt> | <verify-draft|publish-draft> <tag> <source-commit> <owner/repository> [artifact-directory]';
  if (command === 'verify-build-run' && args.length === 6) {
    const [runPath, tag, sourceCommit, repository, runId, runAttempt] = args;
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    assertProductReleaseWorkflowRun({ run, tag, sourceCommit, repository, runId, runAttempt });
    console.log(`Verified Release workflow run ${runId}/${runAttempt} for ${tag}`);
  } else if (command === 'verify-draft' && args.length === 3) {
    const [tag, sourceCommit, repository] = args;
    await verifyDraftProductRelease({ tag, sourceCommit, repository });
    console.log(`Verified Draft product Release ${tag} at ${sourceCommit}`);
  } else if (command === 'publish-draft' && args.length === 4) {
    const [tag, sourceCommit, repository, artifactDirectory] = args;
    await publishDraftProductRelease({
      tag,
      sourceCommit,
      repository,
      artifactDirectory,
    });
    console.log(`Published product Release ${tag} from ${sourceCommit}`);
  } else {
    throw new Error(usage);
  }
}
