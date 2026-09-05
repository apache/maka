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
import test from 'node:test';
import {
  createAttachedWorkspaceExecutionProfile,
  createRuntimeHostWorkspaceExecutionComposition,
  RuntimeHostWorkspaceExecutionError,
} from '../server/workspace-execution-composition.js';

test('executes read-only operations in the attached checkout', async () => {
  const calls: string[] = [];
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    filesystemWorker: {
      async execute(input) {
        calls.push(`${input.cwd}:${input.operation.kind}`);
        return { kind: 'read', content: 'attached' };
      },
    },
  });

  const profile = createAttachedWorkspaceExecutionProfile('/attached');
  assert.deepEqual(
    await composition.executeReadOnly(profile, { kind: 'read', path: 'README.md' }),
    { kind: 'read', content: 'attached' },
  );
  assert.deepEqual(calls, ['/attached:read']);
  await composition.close();
});

test('rejects malformed profiles and mutating operations before worker dispatch', async () => {
  let workerCalls = 0;
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    filesystemWorker: {
      async execute() {
        workerCalls += 1;
        return { kind: 'read', content: 'unsafe' };
      },
    },
  });

  for (const profile of [
    { kind: 'unknown_profile', cwd: '/attached' },
    { kind: 'attached_checkout_v1', cwd: '' },
  ]) {
    await assert.rejects(
      () => composition.executeReadOnly(profile as never, { kind: 'read', path: 'README.md' }),
      (error) =>
        error instanceof RuntimeHostWorkspaceExecutionError &&
        error.code === 'workspace_operation_denied',
    );
  }
  await assert.rejects(
    () =>
      composition.executeReadOnly(createAttachedWorkspaceExecutionProfile('/attached'), {
        kind: 'write',
        path: 'unsafe.txt',
      } as never),
    (error) =>
      error instanceof RuntimeHostWorkspaceExecutionError &&
      error.code === 'workspace_operation_denied',
  );
  assert.equal(workerCalls, 0);
  await composition.close();
});

test('drains active attached operations before closing', async () => {
  let releaseWorker!: () => void;
  const workerBlocked = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    filesystemWorker: {
      async execute() {
        await workerBlocked;
        return { kind: 'read', content: 'attached' };
      },
    },
  });
  const profile = createAttachedWorkspaceExecutionProfile('/attached');

  const executing = composition.executeReadOnly(profile, { kind: 'read', path: 'README.md' });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = composition.close();
  await assert.rejects(
    () => composition.executeReadOnly(profile, { kind: 'read', path: 'other.md' }),
    (error) =>
      error instanceof RuntimeHostWorkspaceExecutionError &&
      error.code === 'workspace_execution_draining',
  );
  assert.equal(composition.state, 'draining');

  releaseWorker();
  await executing;
  await closing;
  assert.equal(composition.state, 'closed');
});
