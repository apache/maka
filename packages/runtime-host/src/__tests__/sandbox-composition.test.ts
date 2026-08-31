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
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import {
  adaptWorkspaceFilesystemWorker,
  runtimeHostFilesystemWorkerRuntime,
} from '../server/sandbox-composition.js';

test('filesystem worker follows the candidate executable runtime', () => {
  assert.equal(runtimeHostFilesystemWorkerRuntime({ electron: '43.1.1' }), 'electron');
  assert.equal(runtimeHostFilesystemWorkerRuntime({}), 'node');
});

test('workspace adapter marks read-only operations outside CAS', async () => {
  let expectedIdentity: unknown;
  const worker = adaptWorkspaceFilesystemWorker({
    execute: async (input) => {
      expectedIdentity = input.expectedIdentity;
      return { kind: 'read', content: 'ok', totalBytes: 2 };
    },
  });

  const result = await worker.execute({
    operation: { kind: 'read', path: 'README.md' },
    cwd: '/workspace',
    executionBoundary: {} as ExecutionBoundary,
  });

  assert.equal(expectedIdentity, 'unchecked');
  assert.equal(result.kind, 'read');
});

test('workspace adapter rejects a mutating filesystem result', async () => {
  const worker = adaptWorkspaceFilesystemWorker({
    execute: async () => ({
      kind: 'write',
      ok: true,
      path: 'README.md',
      bytes: 4,
    }),
  });

  await assert.rejects(
    worker.execute({
      operation: { kind: 'read', path: 'README.md' },
      cwd: '/workspace',
      executionBoundary: {} as ExecutionBoundary,
    }),
    /Read-only filesystem worker returned mutating result write/,
  );
});
