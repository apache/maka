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
import { test } from 'node:test';
import type { CuDispatchBackend } from '@maka/runtime/computer-use-types';
import type { MakaCuBackendOptions } from '../maka-cu-backend.js';
import { selectComputerUseBackend } from '../select-backend.js';

test('service invalidation producer advances Runtime to reobserve', async () => {
  let invalidate:
    | ((input: { sessionId: string; reason: 'child_exit'; outcomeUnknown: boolean }) => void)
    | undefined;
  const backend: CuDispatchBackend = {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return {
        observationId: 'backend-observation',
        appId: 'Fixture',
        pid: 42,
        windowId: 7,
        elements: [],
      };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  const selected = selectComputerUseBackend({
    platform: 'darwin',
    binaryPath: '/tmp/fake-executor',
    expectedBinarySha256: '0'.repeat(64),
    createBackend(options) {
      invalidate = options.onSessionInvalidated as typeof invalidate;
      return backend;
    },
  });
  const [tool] = selected.tools;
  await tool.impl(
    {
      action: 'observe',
      app: 'Fixture',
      include_screenshot: false,
    } as never,
    {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'observe',
      cwd: '/tmp',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    },
  );
  assert.equal(selected.tools.sessionEvents.snapshot('session-1').status, 'active');
  invalidate?.({
    sessionId: 'session-1',
    reason: 'child_exit',
    outcomeUnknown: false,
  });
  assert.equal(selected.tools.sessionEvents.snapshot('session-1').status, 'reobserve_required');
});

test('physical input policy is passed to the selected backend', () => {
  const physicalInputRecentlyActive = () => true;
  let received: MakaCuBackendOptions['physicalInputRecentlyActive'];
  const backend: CuDispatchBackend = {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  selectComputerUseBackend({
    platform: 'darwin',
    binaryPath: '/tmp/fake-executor',
    expectedBinarySha256: '0'.repeat(64),
    physicalInputRecentlyActive,
    createBackend(options) {
      received = options.physicalInputRecentlyActive;
      return backend;
    },
  });
  assert.equal(received, physicalInputRecentlyActive);
});

test('platforms without a binding fail closed instead of no-oping', () => {
  let made = 0;
  for (const platform of ['linux', 'win32', 'freebsd'] as const) {
    const selected = selectComputerUseBackend({
      platform,
      binaryPath: '/tmp/fake-executor',
      expectedBinarySha256: '0'.repeat(64),
      createBackend: () => {
        made += 1;
        return {
          preflight: async () => ({ accessibility: false, screenRecording: false }),
        } as never;
      },
    });
    assert.equal(selected.backendId, 'none');
    assert.equal(selected.backend, undefined);
    assert.equal(selected.tools.length, 0);
    assert.equal(selected.unavailableReason, 'unsupported_platform');
  }
  assert.equal(made, 0, 'an unsupported platform must never reach backend construction');
});

test('typed reasons separate a missing executable from a failed backend', () => {
  const unpinned = selectComputerUseBackend({ platform: 'darwin' });
  assert.equal(unpinned.backendId, 'none');
  assert.equal(unpinned.unavailableReason, 'missing_executable');

  const failed = selectComputerUseBackend({
    platform: 'darwin',
    binaryPath: '/tmp/fake-executor',
    expectedBinarySha256: '0'.repeat(64),
    createBackend() {
      throw new Error('construct failed');
    },
  });
  assert.equal(failed.backendId, 'none');
  assert.equal(failed.unavailableReason, 'backend_failed');
});

test('the platform seam makes Darwin selection assertions run on every CI OS', () => {
  const selected = selectComputerUseBackend({
    platform: 'darwin',
    binaryPath: '/tmp/fake-executor',
    expectedBinarySha256: '0'.repeat(64),
    createBackend() {
      return {
        preflight: async () => ({ accessibility: true, screenRecording: true }),
      } as never;
    },
  });
  assert.equal(selected.backendId, 'maka-cu');
  assert.equal(selected.unavailableReason, undefined);
});
