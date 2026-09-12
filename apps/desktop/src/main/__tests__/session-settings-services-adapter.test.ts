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
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { createDesktopSessionSettingsServices } from '../../renderer/platform/desktop/create-session-settings-services.js';

test('maps session setting services to the existing compound Desktop bridge', async () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const sessions = new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ name: String(property), args });
      if (property === 'abandonPlanProposal') return Promise.resolve({ ok: true, value: {} });
      return Promise.resolve({ ok: true, session: {} });
    },
  });
  const services = createDesktopSessionSettingsServices({
    sessions,
  } as unknown as MakaBridge);

  await services.setModelConfiguration('session-1', {
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'openai',
    model: 'gpt-5',
    thinkingLevel: 'high',
  });
  await services.setPermissionMode('session-1', 'bypass');
  await services.setOrchestrationMode('session-1', 'swarm');
  await services.abandonPlanProposal('session-1', 'proposal-1');

  assert.deepEqual(calls, [
    {
      name: 'setModelConfiguration',
      args: ['session-1', {
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'openai',
        model: 'gpt-5',
        thinkingLevel: 'high',
      }],
    },
    { name: 'setPermissionMode', args: ['session-1', 'bypass'] },
    { name: 'setOrchestrationMode', args: ['session-1', 'swarm'] },
    { name: 'abandonPlanProposal', args: ['session-1', 'proposal-1'] },
  ]);
});

test('unwraps a plan failure only after it reaches the renderer adapter', async () => {
  const services = createDesktopSessionSettingsServices({
    sessions: {
      abandonPlanProposal: async () => ({
        ok: false,
        error: { code: 'operation_conflict', message: 'Host refused the transition' },
      }),
    },
  } as unknown as MakaBridge);

  await assert.rejects(
    () => services.abandonPlanProposal('session-1', 'proposal-1'),
    { name: 'ExpectedOperationError', message: 'operation_conflict' },
  );
});
