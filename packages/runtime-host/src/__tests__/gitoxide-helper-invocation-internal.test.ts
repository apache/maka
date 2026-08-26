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
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  admitGitoxideHelperArtifactInternal,
  type GitoxideHelperInvocationCapability,
  issueGitoxideHelperReleaseArtifactClaimInternal,
} from '../server/gitoxide-helper-artifact-authority-internal.js';
import {
  GITOXIDE_HELPER_ERROR_REASONS_V1,
  GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL,
  GitoxideHelperInvocationError,
  importSourceHeadWithGitoxideHelperInternal,
  inspectRepositoryWithGitoxideHelperInternal,
  runGitoxideOperationWithinDeadlineInternal,
} from '../server/gitoxide-helper-invocation-internal.js';

interface AdmittedHelper {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
}

let admittedHelperPromise: Promise<AdmittedHelper | undefined> | undefined;

test('uses a bounded import deadline distinct from repository inspection', () => {
  assert.deepEqual(GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL, {
    inspectRepositoryMs: 5_000,
    importSourceHeadMs: 10 * 60_000,
  });
});

test('bounds preflight work with the same absolute operation deadline', async () => {
  const startedAt = performance.now();
  await assert.rejects(
    runGitoxideOperationWithinDeadlineInternal({
      deadlineAt: startedAt + 25,
      operation: () => new Promise<never>(() => {}),
    }),
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_invocation_timed_out',
  );
  assert.ok(performance.now() - startedAt < 1_000);
});

test('waits for helper process identity by elapsed time instead of scheduler turns', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-marker-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markerPath = join(root, 'processes.txt');
  const publication = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void writeFile(markerPath, '123 456').then(resolve, reject);
    }, 1_000);
  });

  assert.deepEqual(await waitForProcessMarker(markerPath, 2_000), [123, 456]);
  await publication;
});

test('applies the import deadline and terminates the helper process tree', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-timeout-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markerPath = join(root, 'processes.txt');
  const helperPath = join(root, 'hanging-helper');
  await writeFile(
    helperPath,
    `#!/bin/sh\n/bin/sleep 600 &\nprintf '%s %s' "$$" "$!" > '${escapeSingleQuotedShell(markerPath)}'\nwait\n`,
  );
  await chmod(helperPath, 0o755);
  const helper = await admitHelperPath(helperPath);
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'timeout fixture\n');
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
  const expectedSourceHeadCommitOid = git(repositoryPath, ['rev-parse', 'HEAD']);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const operation = importSourceHeadWithGitoxideHelperInternal({
    ...helper,
    sourceRepositoryPath: repositoryPath,
    expectedSourceHeadCommitOid,
    destinationRepositoryPath: join(root, 'destination.git'),
    baselineRef: 'refs/maka/baseline',
    managedTreePolicyVersion: 2,
  });
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const [helperPid, descendantPid] = await waitForProcessMarker(markerPath);
  t.after(() => {
    for (const pid of [descendantPid, helperPid]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The timeout path already reaped the process tree.
      }
    }
  });

  t.mock.timers.tick(GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'import must not inherit the inspection deadline');

  t.mock.timers.tick(
    GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.importSourceHeadMs -
      GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs,
  );
  await assert.rejects(
    operation,
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_invocation_timed_out',
  );
  await Promise.all([waitForProcessExit(helperPid), waitForProcessExit(descendantPid)]);
  assert.equal(isProcessAlive(helperPid), false);
  assert.equal(isProcessAlive(descendantPid), false);
});

test('bounds Windows forced termination through the shared lifecycle owner', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async (t) => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    t.skip('SystemRoot is required for the Windows lifecycle contract test');
    return;
  }
  const hangingExecutable = join(systemRoot, 'System32', 'charmap.exe');
  try {
    await stat(hangingExecutable);
  } catch {
    t.skip('charmap.exe is unavailable on this Windows runner');
    return;
  }
  const helper = await admitHelperPath(hangingExecutable);
  const repositoryPath = await createRepository(t, 'sha1');
  const startedAt = performance.now();

  await assert.rejects(
    inspectRepositoryWithGitoxideHelperInternal({ ...helper, repositoryPath }),
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_invocation_timed_out',
  );
  assert.ok(
    performance.now() - startedAt < 12_000,
    'Windows process termination must acknowledge or fail within its lifecycle bound',
  );
});

test('rejects an import response that does not match the requested baseline ref', {
  skip: process.platform === 'win32',
}, async (t) => {
  await assertMismatchedImportResponseRejected(t, {
    baselineRef: 'refs/maka/not-the-requested-ref',
  });
});

test('rejects an import response that does not match the requested source HEAD', {
  skip: process.platform === 'win32',
}, async (t) => {
  await assertMismatchedImportResponseRejected(t, {
    sourceHeadCommitOid: 'b'.repeat(40),
  });
});

test('keeps the Rust and TypeScript helper error protocol exhaustive', async () => {
  const rustSource = await readFile(
    new URL('../../../../native/gitoxide-helper/src/main.rs', import.meta.url),
    'utf8',
  );
  const contract = /const HELPER_ERROR_REASONS_V1: &\[&str\] = &\[(?<reasons>[\s\S]*?)\];/.exec(
    rustSource,
  );
  assert.ok(contract?.groups?.reasons, 'Rust helper error contract is missing');
  const rustReasons = [...contract.groups.reasons.matchAll(/"([a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(rustReasons, [...GITOXIDE_HELPER_ERROR_REASONS_V1]);
});

test('observes exact SHA-1 HEAD identity through the admitted helper capability', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'hello from invocation owner\n');
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

  assert.deepEqual(
    await inspectRepositoryWithGitoxideHelperInternal({
      ...helper,
      repositoryPath,
    }),
    {
      kind: 'repository_inspected',
      protocolVersion: 1,
      objectFormat: 'sha1',
      headCommitOid: expectedCommit,
      headTreeOid: expectedTree,
    },
  );
});

test('returns SHA-256 as a policy rejection from the admitted helper', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha256');

  assert.deepEqual(
    await inspectRepositoryWithGitoxideHelperInternal({ ...helper, repositoryPath }),
    {
      kind: 'repository_rejected',
      protocolVersion: 1,
      reason: 'unsupported_object_format',
      objectFormat: 'sha256',
      supportedObjectFormats: ['sha1'],
    },
  );
});

test('normalizes an unknown object format before crossing the helper protocol', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');
  git(repositoryPath, ['config', 'core.repositoryFormatVersion', '1']);
  git(repositoryPath, ['config', 'extensions.objectFormat', 'SHA512']);

  assert.deepEqual(
    await inspectRepositoryWithGitoxideHelperInternal({ ...helper, repositoryPath }),
    {
      kind: 'repository_rejected',
      protocolVersion: 1,
      reason: 'unsupported_object_format',
      objectFormat: 'unknown',
      supportedObjectFormats: ['sha1'],
    },
  );
});

test('reports an unborn SHA-1 repository as a stable helper operation failure', async (t) => {
  const helper = await admittedHelper();
  if (!helper) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required for the real helper contract test');
    return;
  }
  const repositoryPath = await createRepository(t, 'sha1');

  await assert.rejects(
    inspectRepositoryWithGitoxideHelperInternal({ ...helper, repositoryPath }),
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_operation_failed' &&
      error.helperReason === 'head_commit_unavailable',
  );
});

async function admittedHelper(): Promise<AdmittedHelper | undefined> {
  if (admittedHelperPromise) return admittedHelperPromise;
  admittedHelperPromise = (async () => {
    const configuredHelperPath = process.env.MAKA_GITOXIDE_HELPER_PATH;
    if (!configuredHelperPath) return undefined;
    return admitHelperPath(configuredHelperPath);
  })();
  return admittedHelperPromise;
}

async function assertMismatchedImportResponseRejected(
  t: TestContext,
  override: {
    readonly sourceHeadCommitOid?: string;
    readonly baselineRef?: string;
  },
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-correlation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(t, 'sha1');
  await writeFile(join(repositoryPath, 'hello.txt'), 'response correlation fixture\n');
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
  const expectedSourceHeadCommitOid = git(repositoryPath, ['rev-parse', 'HEAD']);
  const sourceTreeOid = git(repositoryPath, ['rev-parse', 'HEAD^{tree}']);
  const helperPath = join(root, 'mismatched-response-helper');
  const response = JSON.stringify({
    protocolVersion: 1,
    kind: 'source_imported',
    objectFormat: 'sha1',
    sourceHeadCommitOid: expectedSourceHeadCommitOid,
    sourceTreeOid,
    baselineCommitOid: 'a'.repeat(40),
    baselineTreeOid: sourceTreeOid,
    baselineRef: 'refs/maka/expected-ref',
    managedTreePolicyVersion: 2,
    filesImported: 1,
    bytesImported: 29,
    ...override,
  });
  await writeFile(helperPath, `#!/bin/sh\n/bin/cat >/dev/null\nprintf '%s\\n' '${response}'\n`);
  await chmod(helperPath, 0o755);
  const helper = await admitHelperPath(helperPath);

  await assert.rejects(
    importSourceHeadWithGitoxideHelperInternal({
      ...helper,
      sourceRepositoryPath: repositoryPath,
      expectedSourceHeadCommitOid,
      destinationRepositoryPath: join(root, 'destination.git'),
      baselineRef: 'refs/maka/expected-ref',
      managedTreePolicyVersion: 2,
    }),
    (error) =>
      error instanceof GitoxideHelperInvocationError &&
      error.code === 'gitoxide_helper_invocation_protocol_invalid',
  );
}

async function admitHelperPath(configuredHelperPath: string): Promise<AdmittedHelper> {
  const helperPath = await realpath(configuredHelperPath);
  const helperBytes = await readFile(helperPath);
  const helperInfo = await stat(helperPath);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const claim = issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath: helperPath,
    expectedSha256: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`,
    expectedBytes: helperInfo.size,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
  });
  const capability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim,
  });
  return { invocationOwnerToken, capability };
}

async function waitForProcessMarker(
  path: string,
  timeoutMs = 10_000,
): Promise<readonly [number, number]> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const [helperPid, descendantPid, ...extra] = (await readFile(path, 'utf8'))
        .trim()
        .split(' ')
        .map(Number);
      if (
        extra.length === 0 &&
        helperPid !== undefined &&
        descendantPid !== undefined &&
        Number.isSafeInteger(helperPid) &&
        Number.isSafeInteger(descendantPid)
      ) {
        return [helperPid, descendantPid];
      }
    } catch {
      // The helper has not published its process identity yet.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Hanging helper did not publish its process identity');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    // The process-group signal has completed, but POSIX may expose a killed
    // descendant as a zombie briefly while its new parent reaps it. This wait
    // uses a real scheduler boundary because this test mocks only setTimeout.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(isProcessAlive(pid), false, `Process ${pid} remained observable after termination`);
}

function escapeSingleQuotedShell(value: string): string {
  return value.replaceAll("'", "'\\''");
}

async function createRepository(t: TestContext, objectFormat: 'sha1' | 'sha256') {
  const repositoryPath = await realpath(await mkdtemp(join(tmpdir(), 'maka-gitoxide-invocation-')));
  t.after(() => rm(repositoryPath, { recursive: true, force: true }));
  git(repositoryPath, ['init', '--quiet', `--object-format=${objectFormat}`]);
  return repositoryPath;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
