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
import { mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  createExecutionRuntimeHostCompositionSource,
  type ExecutionRuntimeHostCompositionSourceOptions,
} from '../server/execution-composition-factory.js';
import type { ExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import type { RuntimeHostCompositionContext } from '../server/host-kernel.js';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
} from '../server/gitoxide-helper-artifact-authority-internal.js';

test('an execution Host starts without a managed Git runtime', async () => {
  const expected = {} as ExecutionRuntimeHostComposition;
  let observed: ExecutionRuntimeHostCompositionSourceOptions | undefined;
  const source = await createExecutionRuntimeHostCompositionSource(
    {},
    {
      createComposition: async (_context, options) => {
        observed = options;
        return expected;
      },
    },
  );

  const actual = await source.create({} as RuntimeHostCompositionContext);

  assert.equal(actual, expected);
  assert.equal(actual.managedFilesResume, false);
  assert.deepEqual(observed, {});
});

test('candidate composition rejects a forged managed helper before execution startup', async () => {
  let started = false;
  const dependencies = {
    managedFilesHelper: {
      invocationOwnerToken: {},
      helperCapability: { kind: 'gitoxide_helper_invocation_capability_v1' as const },
    },
    createComposition: async () => {
      started = true;
      return {} as ExecutionRuntimeHostComposition;
    },
  };
  const source = await createExecutionRuntimeHostCompositionSource({}, dependencies);
  assert.equal(started, false);
  await assert.rejects(
    source.create({} as RuntimeHostCompositionContext),
    /capability is invalid/i,
  );
  assert.equal(started, false);
});

test('candidate defers helper preparation until composition startup', async () => {
  let prepared = 0;
  let started = false;
  const dependencies = {
    prepareManagedFilesHelper: async () => {
      prepared++;
      throw new Error('helper admission stopped');
    },
    createComposition: async () => {
      started = true;
      return {} as ExecutionRuntimeHostComposition;
    },
  };
  const source = await createExecutionRuntimeHostCompositionSource({}, dependencies);
  assert.equal(prepared, 0);
  await assert.rejects(
    source.create({} as RuntimeHostCompositionContext),
    /helper admission stopped/,
  );
  assert.equal(prepared, 1);
  assert.equal(started, false);
});

test('candidate forwards its pinned helper and revalidates bytes at lazy startup', async (t) => {
  if (!process.env.MAKA_GITOXIDE_HELPER_PATH) {
    t.skip('MAKA_GITOXIDE_HELPER_PATH is required');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'maka-helper-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await readFile(process.env.MAKA_GITOXIDE_HELPER_PATH);
  const path = join(root, process.platform === 'win32' ? 'helper.exe' : 'helper');
  await writeFile(path, bytes, { mode: 0o700 });
  const executablePath = await realpath(path);
  const releaseOwnerToken = {};
  const invocationOwnerToken = {};
  const helperCapability = await admitGitoxideHelperArtifactInternal({
    releaseOwnerToken,
    invocationOwnerToken,
    claim: issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
      executablePath,
      expectedBytes: bytes.length,
      expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
      supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
    }),
  });
  const binding = { invocationOwnerToken, helperCapability };
  let starts = 0;
  const source = await createExecutionRuntimeHostCompositionSource(
    {},
    {
      managedFilesHelper: binding,
      createComposition: async (_context, _options, dependencies) => {
        starts++;
        assert.equal(dependencies?.managedFilesHelper?.helperCapability, helperCapability);
        assert.equal(dependencies?.managedFilesHelper?.invocationOwnerToken, invocationOwnerToken);
        return {} as ExecutionRuntimeHostComposition;
      },
    },
  );
  binding.invocationOwnerToken = {};
  const composition = await source.create({} as RuntimeHostCompositionContext);
  assert.equal(composition.managedFilesResume, true);
  assert.equal(Reflect.set(composition, 'managedFilesResume', false), false);
  assert.equal(starts, 1);
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 1;
  await writeFile(path, damaged);
  await assert.rejects(
    source.create({} as RuntimeHostCompositionContext),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'gitoxide_helper_artifact_identity_mismatch',
  );
  assert.equal(starts, 1);
});
