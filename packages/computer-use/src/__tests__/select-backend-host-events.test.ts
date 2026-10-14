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
import type { CuaDriverService } from '../cua-driver-service.js';
import { selectComputerUseBackend } from '../select-backend.js';

test('selected backend enforces physical input and advances Runtime on executor loss', async () => {
  if (process.platform !== 'darwin') return;
  let close: (() => void) | undefined;
  const dispatched: string[] = [];
  const service = {
    snapshot: () => ({ state: 'ready' as const, generation: 1 }),
    dispose: async () => {},
    async call(name: string) {
      switch (name) {
        case 'check_permissions':
          return {
            content: [],
            structuredContent: { accessibility: true, screen_recording: true },
          };
        case 'list_windows':
          return { content: [], structuredContent: { windows: [{ window_id: 7, pid: 42 }] } };
        case 'list_apps':
          return { content: [], structuredContent: { apps: [{ bundle_id: 'Fixture', pid: 42 }] } };
        case 'get_window_state':
          return {
            content: [],
            structuredContent: {
              snapshot_id: 'fixture',
              elements: [
                {
                  element_index: 0,
                  element_token: 'fixture:0',
                  role: 'AXTextField',
                },
              ],
            },
          };
        default:
          dispatched.push(name);
          throw new Error(`Unexpected dispatch: ${name}`);
      }
    },
  } as unknown as CuaDriverService;
  const selected = selectComputerUseBackend({
    binaryPath: '/tmp/fake-executor',
    expectedBinarySha256: '0'.repeat(64),
    physicalInputRecentlyActive: () => true,
    createService(_path, _digest, onClose) {
      close = onClose;
      return service;
    },
  });
  const [tool] = selected.tools;
  const context = (toolCallId: string) => ({
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId,
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  });
  const observed = (await tool.impl(
    {
      action: 'observe',
      app: 'Fixture',
      include_screenshot: false,
    } as never,
    context('observe'),
  )) as { text: string };
  assert.equal(selected.tools.sessionEvents.snapshot('session-1').status, 'active');
  const action = (await tool.impl(
    {
      action: 'type',
      element_id: '0',
      text: 'blocked',
      observation_id: JSON.parse(observed.text).observation_id,
    } as never,
    context('type'),
  )) as { error?: string };
  assert.equal(action.error, 'user_intervened');
  assert.deepEqual(dispatched, []);
  await tool.impl(
    { action: 'observe', app: 'Fixture', include_screenshot: false } as never,
    context('observe-after-intervention'),
  );
  assert.equal(selected.tools.sessionEvents.snapshot('session-1').status, 'active');
  close?.();
  assert.equal(selected.tools.sessionEvents.snapshot('session-1').status, 'reobserve_required');
  selected.backend?.dispose?.();
});
