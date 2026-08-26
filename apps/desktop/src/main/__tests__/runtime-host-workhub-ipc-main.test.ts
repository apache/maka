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
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';

test('projects WorkHub coordination resolution through its dedicated IPC domain', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let resolveCalls = 0;
  const answers: unknown[] = [];
  const records: unknown[] = [];
  const actions: unknown[] = [];
  const changes: unknown[] = [];
  const createdSessionId = 'runtime-created-session';
  registerRuntimeHostWorkHubIpc(
    {
      resolveWorkHubCoordinationSession: async () => {
        resolveCalls += 1;
        return { sessionId: 'maka_workhub_coordination' };
      },
      answerWorkHubCoordination: async (input: { turnId: string; text: string }) => {
        answers.push(input);
        return { turnId: input.turnId };
      },
      recordWorkHubCoordination: async (input: {
        turnId: string;
        userText: string;
        assistantText: string;
      }) => {
        records.push(input);
        return { turnId: input.turnId };
      },
      listWorkHubCoordinationCandidates: async () => ({
        candidateSetId: `sha256:${'a'.repeat(64)}`,
        candidates: [],
      }),
      actWorkHubCoordination: async (input: unknown) => {
        actions.push(input);
        return {
          disposition: 'create_new',
          targetSessionId: createdSessionId,
          targetTurnId: 'created-turn',
        };
      },
    } as never,
    {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as never,
    {
      resolveCreateProject: async () => ({
        kind: 'host_path',
        path: '/tmp/workhub-project',
      }),
      emitSessionsChanged: (reason, sessionId) => changes.push({ reason, sessionId }),
    },
  );

  const handler = handlers.get('workhub:resolveCoordinationSession');
  assert.ok(handler);
  assert.deepEqual(await handler({}), { sessionId: 'maka_workhub_coordination' });
  assert.equal(resolveCalls, 1);
  assert.deepEqual(
    await handlers.get('workhub:answer')?.({}, { turnId: 'answer', text: 'Question' }),
    { turnId: 'answer' },
  );
  assert.deepEqual(
    await handlers.get('workhub:record')?.({}, {
      turnId: 'record',
      userText: 'Request',
      assistantText: 'Summary',
    }),
    { turnId: 'record' },
  );
  assert.deepEqual(answers, [{ turnId: 'answer', text: 'Question' }]);
  assert.deepEqual(records, [{
    turnId: 'record',
    userText: 'Request',
    assistantText: 'Summary',
  }]);
  assert.deepEqual(await handlers.get('workhub:candidates')?.({}), {
    candidateSetId: `sha256:${'a'.repeat(64)}`,
    candidates: [],
  });
  assert.deepEqual(
    await handlers.get('workhub:act')?.({}, {
      actionId: 'create-action',
      userText: 'Start accessibility review',
      proposal: { disposition: 'create_new', title: 'Accessibility review' },
      create: {
        sessionId: 'renderer-invented',
        workspace: { kind: 'host_path', path: '/renderer-path' },
      },
    }),
    {
      disposition: 'create_new',
      targetSessionId: createdSessionId,
      targetTurnId: 'created-turn',
    },
  );
  assert.deepEqual(actions, [{
    actionId: 'create-action',
    userText: 'Start accessibility review',
    proposal: { disposition: 'create_new', title: 'Accessibility review' },
    create: {
      workspace: { kind: 'host_path', path: '/tmp/workhub-project' },
    },
  }]);
  assert.deepEqual(changes, [{ reason: 'created', sessionId: createdSessionId }]);
});
