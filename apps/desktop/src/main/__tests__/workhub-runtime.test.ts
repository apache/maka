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
import { decodeWorkHubCoordinationActFromTurnInput, decodeWorkHubCoordinationSelectAndDelegateInput } from '@maka/runtime-host/protocol';
import { workHubTasksSchema } from '../../shared/workhub-tool-schema.js';
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

test('nested tool calls produce stable task identities accepted by both Host action paths', async () => {
  const f = fixture();
  const toolCallId = `${'p'.repeat(128)}:nested:00000000-0000-4000-8000-000000000001`;
  const actionIds: string[] = [];
  const result = { disposition: 'create_new' as const, targetSessionId: 'target', targetTurnId: 'target-turn' };
  f.client.actWorkHubCoordinationFromTurn = async (input) => {
    actionIds.push(decodeWorkHubCoordinationActFromTurnInput(input).actionId);
    return result;
  };
  f.client.selectAndDelegateWorkHubTarget = async (input) => {
    actionIds.push(decodeWorkHubCoordinationSelectAndDelegateInput(input).actionId);
    return { kind: 'delegated', result };
  };

  const create = { operation: 'create_new' as const, title: 'Work', text: 'Do work' };
  const created = await f.runtime.actTasks(scope, 'turn', toolCallId, create);
  const retried = await f.runtime.actTasks(scope, 'turn', toolCallId, create);
  const selected = await f.runtime.actTasks(scope, 'turn', toolCallId, {
    operation: 'select_and_delegate', candidateSetId: `sha256:${'a'.repeat(64)}`,
    candidateRefs: ['candidate'], text: 'Do work',
  });
  for (const outcome of [created, retried, selected]) {
    assert.ok('actionId' in outcome);
    assert.equal(outcome.actionId, actionIds[0]);
  }
  assert.deepEqual(actionIds, [actionIds[0], actionIds[0], actionIds[0]]);
  const next = await f.runtime.actTasks(scope, 'turn', toolCallId.replace(/1$/, '2'), create);
  assert.ok('actionId' in next);
  assert.equal(next.actionId, actionIds[3]);
  assert.notEqual(next.actionId, actionIds[0]);
});

test('linked task operations remain operations at the Host protocol boundary', async () => {
  const f = fixture();
  await f.runtime.actTasks(scope, 'turn', 'correct-action', {
    operation: 'correct',
    replacesActionId: 'old-action',
    candidateSetId: 'set',
    target: { disposition: 'delegate_existing', candidateRef: 'candidate' },
    text: 'Move the delegated work',
  });
  await f.runtime.actTasks(scope, 'turn', 'stop-action', {
    operation: 'stop',
    targetSessionId: 'target',
  });
  await f.runtime.actTasks(scope, 'turn', 'resume-action', {
    operation: 'resume',
    targetSessionId: 'target',
    resumesActionId: 'stop-action',
  });

  assert.deepEqual(f.requests, [
    {
      turnId: 'turn',
      actionId: 'correct-action',
      proposal: {
        operation: 'correct',
        replacesActionId: 'old-action',
        target: { disposition: 'delegate_existing', candidateRef: 'candidate' },
      },
      delegationText: 'Move the delegated work',
      candidateSetId: 'set',
    },
    {
      turnId: 'turn',
      actionId: 'stop-action',
      proposal: { operation: 'stop', expects: { targetSessionId: 'target' } },
    },
    {
      turnId: 'turn',
      actionId: 'resume-action',
      proposal: {
        operation: 'resume',
        resumesActionId: 'stop-action',
        expects: { targetSessionId: 'target' },
      },
    },
  ]);
});

test('the task tool exposes correction as a linked operation, not a disposition', () => {
  const correction = {
    operation: 'correct',
    replacesActionId: 'old-action',
    target: { disposition: 'create_new', title: 'Replacement' },
    text: 'Correct the earlier delegation',
  };
  assert.deepEqual(workHubTasksSchema.parse(correction), correction);
  assert.equal(
    workHubTasksSchema.safeParse({ ...correction, operation: 'replace' }).success,
    false,
  );
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

test('delegation receipts explicitly distinguish admission from completion evidence', async () => {
  const f = fixture();
  const result = await f.runtime.actTasks(scope, 'turn', 'receipt', { operation: 'create_new', title: 'Work', text: 'Write a plan' });
  assert.deepEqual((result as unknown as Record<string, unknown>).executionEvidence, {
    status: 'admitted', completionVerified: false, artifactsVerified: false,
  });
});

test('task status can be checked without dispatching another task', () => {
  assert.equal(workHubTasksSchema.safeParse({ operation: 'status', targetSessionId: 'target', targetTurnId: 'target-turn' }).success, true);
});

test('status reads exact turn facts without delegation and rejects stale Host or target identity', async () => {
  const f = fixture();
  f.client.listWorkHubCoordinationCandidates = async () => ({ candidateSetId: 'set', candidates: [{ sessionId: 'target' }] }) as unknown as Awaited<ReturnType<typeof f.client.listWorkHubCoordinationCandidates>>;
  f.client.queryTurn = async () => ({ sessionId: 'target', turnId: 'target-turn', runId: 'run', status: 'completed', terminalEventId: 'done' });
  const request = { operation: 'status' as const, targetSessionId: 'target', targetTurnId: 'target-turn' };
  const result = await f.runtime.actTasks(scope, 'turn', 'status-call', request);
  assert.ok('executionEvidence' in result);
  assert.deepEqual(result.executionEvidence, { status: 'completed', scope: 'exact_turn', completionVerified: true, artifactsVerified: false });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.changes, []);
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'other', { ...request, targetSessionId: 'outside' }), /outside current WorkHub discovery/);
  f.client.queryTurn = async () => ({ sessionId: 'wrong', turnId: 'target-turn', runId: 'run', status: 'running' });
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'wrong', request), /identity changed/);
  f.client.queryTurn = async () => { f.retire(); return { sessionId: 'target', turnId: 'target-turn', runId: 'run', status: 'running' }; };
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'stale', request), /Host changed/);
});

test('status does not treat waiting, cancelled or failed execution as completed', async () => {
  const f = fixture();
  f.client.listWorkHubCoordinationCandidates = async () => ({ candidateSetId: 'set', candidates: [{ sessionId: 'target' }] }) as unknown as Awaited<ReturnType<typeof f.client.listWorkHubCoordinationCandidates>>;
  for (const status of ['waiting_for_user', 'cancelled', 'failed'] as const) {
    f.client.queryTurn = async () => ({ sessionId: 'target', turnId: 'target-turn', runId: 'run', status, terminalEventId: 'terminal', abortSource: 'user', failureClass: 'test' });
    const result = await f.runtime.actTasks(scope, 'turn', 'status', { operation: 'status', targetSessionId: 'target', targetTurnId: 'target-turn' });
    assert.ok('executionEvidence' in result);
    assert.equal(result.executionEvidence?.status, status);
    assert.equal(result.executionEvidence?.completionVerified, false);
  }
});

test('stop and resume receipts survive the client capability JSON boundary', async () => {
  const { decodeClientCapabilityResult } = await import('@maka/runtime-host/protocol');
  for (const disposition of ['stop_work', 'resume_work'] as const) {
    const f = fixture();
    f.client.actWorkHubCoordinationFromTurn = async () => ({
      disposition, outcome: disposition === 'stop_work' ? 'stop_delivered' : 'resume_started',
      targetSessionId: 'target', targetTurnId: 'target-turn',
    } as Awaited<ReturnType<typeof f.client.actWorkHubCoordinationFromTurn>>);
    const result = await f.runtime.actTasks(scope, 'turn', 'action', disposition === 'stop_work'
      ? { operation: 'stop', targetSessionId: 'target' }
      : { operation: 'resume', targetSessionId: 'target', resumesActionId: 'previous' });
    assert.deepEqual(decodeClientCapabilityResult({ outcome: 'success', content: [], structuredContent: result }).structuredContent, result);
    assert.equal(Object.hasOwn(result, 'executionEvidence'), false);
  }
});
