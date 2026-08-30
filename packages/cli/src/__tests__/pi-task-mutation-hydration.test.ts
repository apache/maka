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
import type { StoredMessage } from '@maka/core/session';
import type { TaskMutationLookup } from '@maka/runtime-host/protocol';
import { createTaskMutationHydrationController } from '../pi-task-mutation-hydration.js';
import {
  createMakaPiTranscriptState,
  replaceTranscriptWithStoredMessages,
} from '../pi-transcript.js';

test('hydrates exact Task mutations atomically and de-duplicates frozen notices', async () => {
  const state = createMakaPiTranscriptState();
  replaceTranscriptWithStoredMessages(state, taskMessages());
  const queries: string[][] = [];
  let changed = 0;
  const controller = createTaskMutationHydrationController({
    state,
    driver: {
      queryTaskMutations: async (_sessionId, correlations) => {
        queries.push(correlations.map(({ toolCallId }) => toolCallId));
        return correlations.map((correlation) => found(correlation.turnId, correlation.toolCallId));
      },
    },
    onChanged: () => {
      changed += 1;
    },
  });
  controller.replace('session-1');
  const firstTool = taskTool(state);
  state.renderGeometry.entryFirstLine = new Map([[firstTool, 0]]);
  state.renderGeometry.entryLineCount = new Map([[firstTool, 2]]);
  state.renderGeometry.viewportTop = 5;
  controller.schedule('session-1');
  await flush();

  assert.deepEqual(queries, [['call-1']]);
  assert.equal(firstTool.taskMutation?.kind, 'found');
  assert.equal(firstTool.taskMutationVersion, 1);
  assert.equal(state.entries.filter((entry) => entry.kind === 'notice').length, 1);
  assert.equal(changed, 1);

  controller.replace('session-1');
  replaceTranscriptWithStoredMessages(state, taskMessages());
  const replacementTool = taskTool(state);
  state.renderGeometry.entryFirstLine = new Map([[replacementTool, 0]]);
  state.renderGeometry.entryLineCount = new Map([[replacementTool, 2]]);
  controller.schedule('session-1');
  await flush();
  assert.equal(replacementTool.taskMutation?.kind, 'found');
  assert.equal(state.entries.filter((entry) => entry.kind === 'notice').length, 0);
  controller.dispose();
});

test('invokes a driver method with its receiver intact', async () => {
  class Driver {
    #queries = 0;

    async queryTaskMutations(
      _sessionId: string,
      correlations: readonly { readonly turnId: string; readonly toolCallId: string }[],
    ): Promise<readonly TaskMutationLookup[]> {
      this.#queries += 1;
      return correlations.map((correlation) => found(correlation.turnId, correlation.toolCallId));
    }

    queryCount(): number {
      return this.#queries;
    }
  }
  const state = createMakaPiTranscriptState();
  replaceTranscriptWithStoredMessages(state, taskMessages());
  const driver = new Driver();
  const controller = createTaskMutationHydrationController({
    state,
    driver,
    onChanged: () => undefined,
  });
  controller.replace('session-1');
  controller.schedule('session-1');
  await flush();

  assert.equal(driver.queryCount(), 1);
  assert.equal(taskTool(state).taskMutation?.kind, 'found');
  controller.dispose();
});

test('rejects a found presentation whose operation conflicts with the tool call', async () => {
  for (const [toolName, operation] of [
    ['task_create', 'update'],
    ['task_update', 'create'],
  ] as const) {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, taskMessages(toolName));
    let changed = 0;
    const controller = createTaskMutationHydrationController({
      state,
      driver: {
        queryTaskMutations: async (_sessionId, correlations) =>
          correlations.map((correlation) => mismatchedFound(correlation, operation)),
      },
      onChanged: () => {
        changed += 1;
      },
    });
    controller.replace('session-1');
    controller.schedule('session-1');
    await flush();

    assert.equal(taskTool(state).taskMutation, undefined);
    assert.equal(changed, 0);
    controller.dispose();
  }
});

test('drops a late hydration after same-session transcript replacement', async () => {
  const state = createMakaPiTranscriptState();
  replaceTranscriptWithStoredMessages(state, taskMessages());
  const pending = deferred<readonly TaskMutationLookup[]>();
  const controller = createTaskMutationHydrationController({
    state,
    driver: { queryTaskMutations: async () => pending.promise },
    onChanged: () => assert.fail('stale hydration must not publish'),
  });
  controller.replace('session-1');
  controller.schedule('session-1');
  controller.replace('session-1');
  replaceTranscriptWithStoredMessages(state, taskMessages());
  pending.resolve([found('turn-1', 'call-1')]);
  await flush();
  assert.equal(taskTool(state).taskMutation, undefined);
  controller.dispose();
});

test('does not announce hydration while the rendered tool still crosses the viewport', async () => {
  const state = createMakaPiTranscriptState();
  replaceTranscriptWithStoredMessages(state, taskMessages());
  const tool = taskTool(state);
  state.renderGeometry.entryFirstLine = new Map([[tool, 3]]);
  state.renderGeometry.entryLineCount = new Map([[tool, 4]]);
  state.renderGeometry.viewportTop = 5;
  let changed = 0;
  const controller = createTaskMutationHydrationController({
    state,
    driver: {
      queryTaskMutations: async (_sessionId, correlations) =>
        correlations.map((correlation) => found(correlation.turnId, correlation.toolCallId)),
    },
    onChanged: () => {
      changed += 1;
    },
  });
  controller.replace('session-1');
  controller.schedule('session-1');
  await flush();

  assert.equal(tool.taskMutation?.kind, 'found');
  assert.equal(
    state.entries.some((entry) => entry.kind === 'notice'),
    false,
  );
  assert.equal(changed, 1);
  controller.dispose();
});

test('keeps running unresolved history hidden until a settled projection is queried', async () => {
  const state = createMakaPiTranscriptState();
  replaceTranscriptWithStoredMessages(state, taskMessages());
  const tool = taskTool(state);
  tool.callStatus = 'running';
  const controller = createTaskMutationHydrationController({
    state,
    driver: {
      queryTaskMutations: async (_sessionId, correlations) =>
        correlations.map((correlation) => ({ kind: 'not_found', correlation })),
    },
    onChanged: () => undefined,
  });
  controller.replace('session-1');
  controller.schedule('session-1');
  await flush();
  assert.deepEqual(tool.taskMutation, {
    kind: 'unresolved',
    reason: 'not_found',
    observedSettled: false,
    fingerprint: tool.taskMutation?.fingerprint,
  });

  tool.callStatus = 'completed';
  assert.equal(
    tool.taskMutation?.kind === 'unresolved' && tool.taskMutation.observedSettled,
    false,
  );
  controller.schedule('session-1');
  await flush();
  assert.equal(tool.taskMutation?.kind === 'unresolved' && tool.taskMutation.observedSettled, true);
  controller.dispose();
});

function taskMessages(toolName: 'task_create' | 'task_update' = 'task_create'): StoredMessage[] {
  return [
    {
      type: 'tool_call',
      id: 'call-1',
      turnId: 'turn-1',
      ts: 1,
      toolName,
      args: { tasks: [{ subject: 'First task' }] },
    },
    {
      type: 'tool_result',
      id: 'result-1',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'call-1',
      isError: false,
      content: { kind: 'text', text: 'Created' },
    },
  ];
}

function mismatchedFound(
  correlation: { readonly turnId: string; readonly toolCallId: string },
  operation: 'create' | 'update',
): TaskMutationLookup {
  return operation === 'create'
    ? {
        kind: 'found',
        correlation,
        presentation: {
          operation,
          correlation,
          changes: [
            {
              taskId: 'task-1',
              key: 'T1',
              subject: 'First task',
              nextStatus: 'pending',
            },
          ],
        },
      }
    : {
        kind: 'found',
        correlation,
        presentation: {
          operation,
          correlation,
          changes: [
            {
              taskId: 'task-1',
              key: 'T1',
              subject: 'First task',
              previousStatus: 'pending',
              nextStatus: 'completed',
            },
          ],
        },
      };
}

function taskTool(state: ReturnType<typeof createMakaPiTranscriptState>) {
  const tool = state.entries.find(
    (entry): entry is Extract<(typeof state.entries)[number], { kind: 'tool' }> =>
      entry.kind === 'tool' && entry.toolUseId === 'call-1',
  );
  if (!tool) throw new Error('Expected Task tool entry');
  return tool;
}

function found(turnId: string, toolCallId: string): TaskMutationLookup {
  const correlation = { turnId, toolCallId };
  return {
    kind: 'found',
    correlation,
    presentation: {
      operation: 'create',
      correlation,
      changes: [
        {
          taskId: 'task-1',
          key: 'T1',
          subject: 'First task',
          nextStatus: 'pending',
        },
      ],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
