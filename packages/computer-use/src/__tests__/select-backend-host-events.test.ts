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

const runningTarget = {
  kind: 'running' as const,
  identity: { kind: 'bundle_id' as const, bundleId: 'com.example.Fixture' },
  selector: { pid: 42, processGeneration: 'pst:1', windowId: 7 },
};

const preparationBackend = {
  async ensureReady() {},
  async resolveTarget() {
    return {
      kind: 'resolved' as const,
      target: runningTarget,
    };
  },
};

test('service invalidation producer advances Runtime to reobserve', async () => {
  if (process.platform !== 'darwin') return;
  let invalidate:
    | ((input: { sessionId: string; reason: 'child_exit'; outcomeUnknown: boolean }) => void)
    | undefined;
  const backend: CuDispatchBackend = {
    ...preparationBackend,
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return {
        observationId: 'backend-observation',
        appId: 'Fixture',
        pid: 42,
        windowId: 7,
        target: runningTarget,
        elements: [],
      };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  const selected = selectComputerUseBackend({
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
  if (process.platform !== 'darwin') return;
  const physicalInputRecentlyActive = () => true;
  let received: MakaCuBackendOptions['physicalInputRecentlyActive'];
  const backend: CuDispatchBackend = {
    ...preparationBackend,
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  selectComputerUseBackend({
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
