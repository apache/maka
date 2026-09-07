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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  admitGitoxideHelperArtifactInternal,
  GitoxideHelperArtifactAuthorityError,
  issueGitoxideHelperReleaseArtifactClaimInternal,
  type GitoxideHelperReleaseArtifactClaim,
  verifyGitoxideHelperArtifactForInvocationInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';

test('rejects a caller-forged Gitoxide helper release claim', async () => {
  const forgedClaim = Object.freeze({
    kind: 'gitoxide_helper_release_artifact_claim_v1',
  }) as GitoxideHelperReleaseArtifactClaim;

  await assert.rejects(
    admitGitoxideHelperArtifactInternal({
      releaseOwnerToken: {},
      invocationOwnerToken: {},
      claim: forgedClaim,
    }),
    (error) =>
      error instanceof GitoxideHelperArtifactAuthorityError &&
      error.code === 'gitoxide_helper_release_claim_invalid',
  );
});

test('rejects a release claim reached through a symbolic link or junction', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-helper-artifact-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetDirectory = join(directory, 'target');
  const claimedDirectory = join(directory, 'claimed');
  const targetPath = join(targetDirectory, 'helper');
  const claimedPath = join(claimedDirectory, 'helper');
  const bytes = Buffer.from('trusted helper bytes');
  await mkdir(targetDirectory);
  await writeFile(targetPath, bytes);
  try {
    await symlink(
      targetDirectory,
      claimedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('This Windows host cannot create symbolic links');
      return;
    }
    throw error;
  }

  const releaseOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: claimedPath,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    expectedBytes: bytes.length,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: ['inspect_repository', 'import_source_head'],
  });

  await assert.rejects(
    admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken: {},
      claim,
    }),
    (error) =>
      error instanceof GitoxideHelperArtifactAuthorityError &&
      error.code === 'gitoxide_helper_artifact_invalid',
  );
});

test('keeps an admitted helper artifact opaque and bound to its invocation owner', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-helper-artifact-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executablePath = join(directory, 'helper');
  const bytes = Buffer.from('trusted helper bytes');
  await writeFile(executablePath, bytes);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    expectedBytes: bytes.length,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: ['inspect_repository', 'import_source_head'],
  });

  const capability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });

  assert.deepEqual(capability, { kind: 'gitoxide_helper_invocation_capability_v1' });
  await assert.rejects(
    verifyGitoxideHelperArtifactForInvocationInternal({}, capability),
    (error) =>
      error instanceof GitoxideHelperArtifactAuthorityError &&
      error.code === 'gitoxide_helper_invocation_capability_invalid',
  );
  assert.equal(
    (await verifyGitoxideHelperArtifactForInvocationInternal(invocationOwnerToken, capability))
      .executablePath,
    executablePath,
  );
});

test('rejects a helper artifact changed after admission', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-helper-artifact-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executablePath = join(directory, 'helper');
  const bytes = Buffer.from('trusted helper bytes');
  await writeFile(executablePath, bytes);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    expectedBytes: bytes.length,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: ['inspect_repository', 'import_source_head'],
  });
  const capability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });

  await writeFile(executablePath, Buffer.alloc(bytes.length, 0x78));

  await assert.rejects(
    verifyGitoxideHelperArtifactForInvocationInternal(invocationOwnerToken, capability),
    (error) =>
      error instanceof GitoxideHelperArtifactAuthorityError &&
      error.code === 'gitoxide_helper_artifact_identity_mismatch',
  );
});
