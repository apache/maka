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
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { createWorkHubRuntime } from '../workhub-runtime.js';

const scope = { hostId: 'host', targetEpoch: 'epoch' };
function fixture() {
  let current = true;
  const requests: unknown[] = [];
  const stops: unknown[] = [];
  const changes: unknown[] = [];
  const deps: Parameters<typeof createWorkHubRuntime>[0] = {
    isCurrent: () => current,
    client: () => client,
    createContext: async () => ({ workspace: { kind: 'project', projectId: 'project' }, defaults: { permissionMode: 'ask' } }),
    changed: (...args) => { changes.push(args); },
  };
  const client = {
    queryTurn: async () => ({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run', status: 'running' as const }),
    stopTurn: async (input: unknown) => { stops.push(input); },
    listWorkHubCoordinationCandidates: async () => ({ candidateSetId: 'set', candidates: [] }),
    actWorkHubCoordinationFromTurn: async (input: unknown) => {
      requests.push(input);
      return { disposition: 'create_new' as const, targetSessionId: 'target', targetTurnId: 'target-turn' };
    },
  } as unknown as ReturnType<typeof deps.client>;
  return { deps, client, requests, stops, changes, retire: () => { current = false; }, runtime: createWorkHubRuntime(deps) };
}

test('task delegation binds the tool action to the Host turn and trusted creation context', async () => {
  const f = fixture();
  const result = await f.runtime.actTasks(scope, 'turn', 'tool-call', { operation: 'create_new', title: 'Fix login', text: 'Implement and test the login fix' });
  assert.deepEqual(f.requests, [{
    turnId: 'turn', actionId: 'tool-call', proposal: { disposition: 'create_new', title: 'Fix login' },
    delegationText: 'Implement and test the login fix', create: { workspace: { kind: 'project', projectId: 'project' } },
    newWorkDefaults: { permissionMode: 'ask' },
  }]);
  assert.ok('actionId' in result);
  assert.equal(result.actionId, 'tool-call');
  assert.deepEqual(f.changes, [[scope, 'created', 'target']]);
});

test('a Host switch while resolving the workspace prevents delegation', async () => {
  const f = fixture();
  const original = f.deps.createContext;
  f.deps.createContext = async (target) => { const context = await original(target); f.retire(); return context; };
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'tool-call', { operation: 'create_new', title: 'Work', text: 'Do work' }), /Runtime Host changed/);
  assert.deepEqual(f.requests, []);
});

test('takeover stops the exact old turn and run even after selecting another Host', async () => {
  const f = fixture();
  f.retire();
  await f.runtime.interrupt(scope, 'turn');
  assert.deepEqual(f.stops, [{ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run' }]);
  await assert.rejects(f.runtime.assertTurn(scope, 'turn'), /Runtime Host changed/);
});

test('a changed turn identity cannot become the takeover target', async () => {
  const f = fixture();
  f.client.queryTurn = async () => ({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'new-turn', runId: 'new-run', status: 'running' });
  await assert.rejects(f.runtime.interrupt(scope, 'turn'), /turn identity changed/);
  assert.deepEqual(f.stops, []);
});
