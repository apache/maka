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
import { describe, test } from 'node:test';

import { SandboxCommandError, serializeSandboxError } from '../sandbox/errors.js';
import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';

describe('sandbox error diagnostics', () => {
  test('serializes stable metadata without copying the raw error message', () => {
    const error = new SandboxCommandError({
      domain: 'command',
      stage: 'transform',
      reason: 'backend_not_available',
      backend: 'macos-seatbelt',
      recoverable: false,
      profileName: 'workspace-write',
      message: 'private path: /Users/example/secret',
    });

    const serialized = serializeSandboxError(error);
    assert.deepEqual(serialized, {
      domain: 'command',
      stage: 'transform',
      reason: 'backend_not_available',
      recoverable: false,
      backend: 'macos-seatbelt',
      profileName: 'workspace-write',
    });
    assert.equal(JSON.stringify(serialized).includes('/Users/example/secret'), false);
  });

  test('serializes filesystem worker validation failures through the same contract', () => {
    const serialized = serializeSandboxError(
      new FilesystemWorkerClientError({
        reason: 'path_denied',
        stage: 'validation',
        recoverable: false,
        requestId: 'request-1',
      }),
    );

    assert.deepEqual(serialized, {
      domain: 'filesystem',
      stage: 'validation',
      reason: 'path_denied',
      recoverable: false,
      requestId: 'request-1',
    });
  });

  test('preserves the exact expansion required for a session boundary request', () => {
    const serialized = serializeSandboxError(
      new FilesystemWorkerClientError({
        reason: 'sandbox_boundary_required',
        stage: 'validation',
        recoverable: true,
        requestId: 'request-2',
        requiredExpansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
      }),
    );

    assert.deepEqual(serialized, {
      domain: 'filesystem',
      stage: 'validation',
      reason: 'sandbox_boundary_required',
      recoverable: true,
      requestId: 'request-2',
      requiredExpansion: {
        filesystem: {
          entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
        },
      },
    });
  });

  test('rejects malformed required expansions instead of laundering them into diagnostics', () => {
    const serialized = serializeSandboxError({
      domain: 'filesystem',
      stage: 'validation',
      reason: 'sandbox_boundary_required',
      recoverable: true,
      requiredExpansion: {
        filesystem: {
          entries: [{ path: 'relative.txt', access: 'read', scope: 'exact' }],
        },
      },
    });

    assert.deepEqual(serialized, {
      domain: 'filesystem',
      stage: 'validation',
      reason: 'sandbox_boundary_required',
      recoverable: true,
    });
  });
});
