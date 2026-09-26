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
import type { PlanSessionState } from '@maka/core/plan';
import type { SessionSettingsServices } from '../../renderer/features/session-settings/index.js';
import { writeSessionPlanMode } from '../../renderer/features/session-settings/testing.js';

function fixture(state: Partial<PlanSessionState> = {}, confirmed = true) {
  const writes: unknown[] = [];
  const errors: string[] = [];
  const confirmations: string[] = [];
  const services = {
    getPlanState: async (sessionId) => ({ schemaVersion: 1, sessionId, storeVersion: 0, proposals: [], executions: [], ...state }),
    abandonPlanProposal: async (...args) => { writes.push(['abandon', ...args]); },
    setCollaborationMode: async (...args) => { writes.push(['mode', ...args]); return {} as never; },
  } satisfies Pick<SessionSettingsServices, 'getPlanState' | 'abandonPlanProposal' | 'setCollaborationMode'>;
  const presentation = {
    reportExecutionActive: (id: string) => { errors.push(id); },
    confirmDiscard: async (title: string) => { confirmations.push(title); return confirmed; },
  };
  return { services, presentation, writes, errors, confirmations };
}

test('entering Plan is refused when the Host reports an active execution', async () => {
  const f = fixture({ activeExecutionId: 'execution' });
  assert.equal(await writeSessionPlanMode(f.services, f.presentation, 'a', true), false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.errors, ['a']);
});

test('canceling the latest pending proposal confirmation makes no write', async () => {
  const f = fixture({ latestProposalId: 'p', proposals: [{ proposalId: 'p', title: 'Keep this', status: 'pending_approval' } as never] }, false);
  assert.equal(await writeSessionPlanMode(f.services, f.presentation, 'a', false), false);
  assert.deepEqual(f.confirmations, ['Keep this']);
  assert.deepEqual(f.writes, []);
});

test('ordinary Plan transitions write only collaboration mode, preserving orchestration', async () => {
  const f = fixture();
  assert.equal(await writeSessionPlanMode(f.services, f.presentation, 'a', true), true);
  assert.equal(await writeSessionPlanMode(f.services, f.presentation, 'a', false), true);
  assert.deepEqual(f.writes, [['mode', 'a', 'plan'], ['mode', 'a', 'agent']]);
  assert.deepEqual(f.confirmations, []);
});

test('Host read errors propagate to the intent error path without writing', async () => {
  const f = fixture();
  f.services.getPlanState = async () => { throw new Error('offline'); };
  await assert.rejects(writeSessionPlanMode(f.services, f.presentation, 'a', true), /offline/);
  assert.deepEqual(f.writes, []);
});
