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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  admitGitoxideHelperArtifactInternal,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  admitGitoxideRepositoryInternal,
  GitoxideRepositoryAdmissionAuthorityError,
  importAdmittedGitoxideRepositoryInternal,
  requireGitoxideRepositoryAdmissionInternal,
} from '../server/gitoxide-repository-admission-authority-internal.js';
import { GitoxideHelperInvocationError } from '../server/gitoxide-helper-invocation-internal.js';

interface AdmittedHelper {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly helperArtifactSha256: `sha256:${string}`;
}

let admittedHelperPromise: Promise<AdmittedHelper | undefined> | undefined;

test('applies admission cancellation before repository path preflight', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    admitGitoxideRepositoryInternal({
      invocationOwnerToken: {},
      helperCapability: {} as GitoxideHelperInvocationCapability,
      admissionOwnerToken: {},
      repositoryPath: join(tmpdir(), 'missing-gitoxide-admission-repository'),
      abortSignal: controller.signal,
    }),
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_invocation_aborted',
  );
});

test('issues an opaque owner-bound admission capability from the exact helper observation', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from admission authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const expectedCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
  const expectedTree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const admissionOwnerToken = {};

  const result = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });

  assert.equal(result.kind, 'accepted');
  if (result.kind !== 'accepted') return;
  assert.deepEqual(result.capability, { kind: 'gitoxide_repository_admission_capability_v1' });
  assert.throws(
    () => requireGitoxideRepositoryAdmissionInternal({}, result.capability),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
  assert.deepEqual(
    requireGitoxideRepositoryAdmissionInternal(admissionOwnerToken, result.capability),
    {
      protocolVersion: 1,
      repositoryPath,
      objectFormat: 'sha1',
      headCommitOid: expectedCommit,
      headTreeOid: expectedTree,
      helperArtifactSha256: helper.helperArtifactSha256,
      managedTreePolicyVersion: 2,
    },
  );
});

test('returns a policy rejection without issuing an admission capability', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha256');

  assert.deepEqual(
    await admitGitoxideRepositoryInternal({
      ...helper,
      admissionOwnerToken: {},
      repositoryPath,
    }),
    {
      kind: 'repository_rejected',
      protocolVersion: 1,
      reason: 'unsupported_object_format',
      objectFormat: 'sha256',
      supportedObjectFormats: ['sha1'],
    },
  );
});

test('imports only the exact repository identity bound to the admission capability', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from source import authority\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const expectedCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
  const expectedTree = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;
  const destinationRepositoryPath = join(repositoryPath, 'managed.git');

  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    destinationRepositoryPath,
    baselineRef: 'refs/maka/baseline',
  });

  assert.equal(imported.sourceHeadCommitOid, expectedCommit);
  assert.equal(imported.sourceTreeOid, expectedTree);
  assert.equal(imported.baselineTreeOid, expectedTree);
  assert.equal(
    gitBare(destinationRepositoryPath, ['rev-parse', 'refs/maka/baseline']),
    imported.baselineCommitOid,
  );
  await assert.rejects(
    importAdmittedGitoxideRepositoryInternal({
      admissionOwnerToken: {},
      repositoryCapability: admitted.capability,
      destinationRepositoryPath: join(repositoryPath, 'forged.git'),
      baselineRef: 'refs/maka/forged',
    }),
    (error) =>
      error instanceof GitoxideRepositoryAdmissionAuthorityError &&
      error.code === 'gitoxide_repository_admission_capability_invalid',
  );
});

test('reuses the exact helper capability captured by repository admission', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'bind helper identity\n');
  git(repositoryPath, ['add', 'hello.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=maka@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    ...helper,
    admissionOwnerToken,
    repositoryPath,
  });
  assert.equal(admitted.kind, 'accepted');
  if (admitted.kind !== 'accepted') return;

  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    destinationRepositoryPath: join(repositoryPath, 'captured-helper-import.git'),
    baselineRef: 'refs/maka/baseline',
  });
  assert.equal(imported.sourceHeadCommitOid, git(repositoryPath, ['rev-parse', 'HEAD']));
});

async function admittedHelper(): Promise<AdmittedHelper | undefined> {
  if (admittedHelperPromise) return admittedHelperPromise;
  admittedHelperPromise = (async () => {
    const configuredHelperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
    if (!configuredHelperPath) return undefined;
    const helperPath = await realpath(configuredHelperPath);
    const helperBytes = await readFile(helperPath);
    const helperInfo = await stat(helperPath);
    const helperArtifactSha256 =
      `sha256:${createHash('sha256').update(helperBytes).digest('hex')}` as const;
    const releaseOwnerToken = {};
    const invocationOwnerToken = {};
    const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
      executablePath: helperPath,
      expectedSha256: helperArtifactSha256,
      expectedBytes: helperInfo.size,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
    });
    const helperCapability = await admitGitoxideHelperArtifactInternal({
      releaseOwnerToken,
      invocationOwnerToken,
      claim,
    });
    return { invocationOwnerToken, helperCapability, helperArtifactSha256 };
  })();
  return admittedHelperPromise;
}

async function createRepository(t: TestContext, objectFormat: 'sha1' | 'sha256') {
  const repositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-admission-')));
  t.after(() => rm(repositoryPath, { recursive: true, force: true }));
  git(repositoryPath, ['init', '--quiet', `--object-format=${objectFormat}`]);
  return repositoryPath;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function gitBare(repositoryPath: string, args: readonly string[]): string {
  return execFileSync('git', [`--git-dir=${repositoryPath}`, ...args], {
    encoding: 'utf8',
  }).trim();
}
