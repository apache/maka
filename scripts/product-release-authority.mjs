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
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  compareProductReleaseNames,
  readProductReleasePublicationRecord,
  verifyProductReleasePublicationRecord,
} from './product-release-artifacts.mjs';
import { parseAsfSourceReferenceTag } from './product-release-identity.mjs';
import { parseProductTag, remoteProductTagCommit } from './product-release-tag.mjs';

const execFileAsync = promisify(execFile);

function expectedReleaseIdentity(tag) {
  const { prerelease, version } = parseProductTag(tag);
  return {
    tag,
    version,
    isPrerelease: prerelease.length > 0,
    attestationName: `Maka-${version}-attestation.sigstore.json`,
  };
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

export function assertPublishedProductRelease(release, tag, releaseId, expectedAssets) {
  const expected = expectedReleaseIdentity(tag);
  if (!release || release.id !== releaseId || release.tag !== tag || release.draft !== false) {
    throw new Error(`GitHub Release ${tag} was not published`);
  }
  if (release.prerelease !== expected.isPrerelease) {
    throw new Error(`GitHub Release ${tag} prerelease state must be ${expected.isPrerelease}`);
  }
  if (JSON.stringify(release.assets) !== JSON.stringify(expectedAssets)) {
    throw new Error(`GitHub Release ${tag} assets changed during publication`);
  }
  return release;
}

function releaseSnapshotFromGhView(value) {
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

function releaseSnapshotFromRest(value) {
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

async function localAssetRecord(path) {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0) {
    throw new Error('Product release attestation bundle must be a non-empty regular file');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { name: basename(path), size: details.size, digest: `sha256:${hash.digest('hex')}` };
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
  publicationRecordPath,
  sourceReferenceTag,
  releaseRunId,
  releaseRunAttempt,
  attestationBundlePath,
  cwd = process.cwd(),
  run = execFileAsync,
  pause = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const releaseIdentity = expectedReleaseIdentity(tag);
  const attestation = await localAssetRecord(attestationBundlePath);
  if (attestation.name !== releaseIdentity.attestationName) {
    throw new Error(`Product release attestation must be named ${releaseIdentity.attestationName}`);
  }
  const { draft, evidence } = await verifyDraftProductReleasePublication({
    tag,
    sourceCommit,
    repository,
    artifactDirectory,
    publicationRecordPath,
    sourceReferenceTag,
    releaseRunId,
    releaseRunAttempt,
    cwd,
    run,
  });

  await run(
    'gh',
    ['release', 'upload', tag, attestationBundlePath, '--repo', repository, '--clobber'],
    { cwd },
  );
  const attestedDraft = await verifyDraftProductRelease({
    tag,
    sourceCommit,
    repository,
    cwd,
    run,
  });
  const expectedAssets = [...evidence.assets, attestation].sort((left, right) =>
    compareProductReleaseNames(left.name, right.name),
  );
  if (JSON.stringify(attestedDraft.assets) !== JSON.stringify(expectedAssets)) {
    throw new Error('Draft GitHub Release does not contain the exact attestation bundle');
  }

  const isPrerelease = releaseIdentity.isPrerelease;
  const published = await run(
    'gh',
    [
      'api',
      '--header',
      'X-GitHub-Api-Version: 2026-03-10',
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
  assertPublishedProductRelease(record, tag, draft.id, expectedAssets);

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

export async function verifyDraftProductReleasePublication({
  tag,
  sourceCommit,
  repository,
  artifactDirectory,
  publicationRecordPath,
  sourceReferenceTag,
  releaseRunId,
  releaseRunAttempt,
  cwd = process.cwd(),
  run = execFileAsync,
}) {
  const releaseIdentity = expectedReleaseIdentity(tag);
  const evidence = await readProductReleasePublicationRecord(publicationRecordPath, {
    repository,
    tag,
    sourceCommit,
    sourceReferenceTag,
    runId: releaseRunId,
    runAttempt: releaseRunAttempt,
  });
  await verifyProductReleasePublicationRecord({
    artifactDirectory,
    record: evidence,
    expected: {
      repository,
      tag,
      sourceCommit,
      sourceReferenceTag,
      runId: releaseRunId,
      runAttempt: releaseRunAttempt,
    },
  });
  const draft = await verifyDraftProductRelease({ tag, sourceCommit, repository, cwd, run });
  const remoteAssets = (draft.assets ?? [])
    .map(({ name, size, digest }) => ({ name, size, digest }))
    .sort((left, right) => compareProductReleaseNames(left.name, right.name));
  const allowedDraftAssets = remoteAssets.filter(
    ({ name }) => name !== releaseIdentity.attestationName,
  );
  const unexpectedAttestations = remoteAssets.filter(
    ({ name }) =>
      name.endsWith('-attestation.sigstore.json') && name !== releaseIdentity.attestationName,
  );
  if (
    unexpectedAttestations.length > 0 ||
    JSON.stringify(allowedDraftAssets) !== JSON.stringify(evidence.assets)
  ) {
    throw new Error('Draft GitHub Release assets do not match the verified Release run artifacts');
  }
  return { draft, evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const usage =
    'usage: product-release-authority.mjs verify-build-run <run-json> <tag> <source-commit> <owner/repository> <run-id> <run-attempt> | verify-draft <tag> <source-commit> <owner/repository> | verify-publication <tag> <source-commit> <owner/repository> <artifact-directory> <publication-record> <source-reference-tag> <run-id> <run-attempt> | publish-draft <tag> <source-commit> <owner/repository> <artifact-directory> <publication-record> <source-reference-tag> <run-id> <run-attempt> <attestation-bundle>';
  if (command === 'verify-build-run' && args.length === 6) {
    const [runPath, tag, sourceCommit, repository, runId, runAttempt] = args;
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    assertProductReleaseWorkflowRun({ run, tag, sourceCommit, repository, runId, runAttempt });
    console.log(`Verified Release workflow run ${runId}/${runAttempt} for ${tag}`);
  } else if (command === 'verify-draft' && args.length === 3) {
    const [tag, sourceCommit, repository] = args;
    await verifyDraftProductRelease({ tag, sourceCommit, repository });
    console.log(`Verified Draft product Release ${tag} at ${sourceCommit}`);
  } else if (command === 'verify-publication' && args.length === 8) {
    const [
      tag,
      sourceCommit,
      repository,
      artifactDirectory,
      publicationRecordPath,
      sourceReferenceTag,
      releaseRunId,
      releaseRunAttempt,
    ] = args;
    await verifyDraftProductReleasePublication({
      tag,
      sourceCommit,
      repository,
      artifactDirectory,
      publicationRecordPath,
      sourceReferenceTag,
      releaseRunId,
      releaseRunAttempt,
    });
    console.log(`Verified exact publication input for ${tag}`);
  } else if (command === 'publish-draft' && args.length === 9) {
    const [
      tag,
      sourceCommit,
      repository,
      artifactDirectory,
      publicationRecordPath,
      sourceReferenceTag,
      releaseRunId,
      releaseRunAttempt,
      attestationBundlePath,
    ] = args;
    await publishDraftProductRelease({
      tag,
      sourceCommit,
      repository,
      artifactDirectory,
      publicationRecordPath,
      sourceReferenceTag,
      releaseRunId,
      releaseRunAttempt,
      attestationBundlePath,
    });
    console.log(`Published product Release ${tag} from ${sourceCommit}`);
  } else {
    throw new Error(usage);
  }
}
