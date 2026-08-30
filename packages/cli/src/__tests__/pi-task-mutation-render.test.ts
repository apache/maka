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
import { MakaTranscriptComponent } from '../pi-tui-layout.js';
import {
  createMakaPiTranscriptState,
  renderMakaPiTranscript,
  replaceTranscriptWithStoredMessages,
} from '../pi-transcript.js';

test('renders 20 creates inline and summarizes 21 only on the live surface', () => {
  for (const count of [20, 21]) {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, taskMessages('task_create'));
    const tool = onlyTool(state);
    tool.taskMutation = {
      kind: 'found',
      fingerprint: `create-${count}`,
      presentation: {
        operation: 'create',
        correlation: { turnId: 'turn-1', toolCallId: 'call-1' },
        changes: Array.from({ length: count }, (_, index) => ({
          taskId: `task-${index + 1}`,
          key: `T${index + 1}`,
          subject: `Task ${index + 1}`,
          nextStatus: 'pending' as const,
        })),
      },
    };
    tool.taskMutationVersion = 1;
    const live = plain(renderMakaPiTranscript(state, metadata(), 100));
    const document = plain(
      new MakaTranscriptComponent(state, metadata).createDocumentRenderer()(100),
    );
    if (count === 20) {
      assert.match(live, /T20\s+pending\s+Task 20/);
    } else {
      assert.match(live, /Added 21 tasks · \/transcript to view full list/);
      assert.doesNotMatch(live, /T21\s+pending/);
      assert.match(document, /T21\s+pending\s+Task 21/);
    }
  }
});

test('leaves task_list and task_get on the ordinary tool renderer', () => {
  for (const toolName of ['task_list', 'task_get'] as const) {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, taskMessages(toolName));
    const rendered = plain(renderMakaPiTranscript(state, metadata(), 100));
    assert.doesNotMatch(rendered, /Added \d+ tasks|Task details unavailable/);
    assert.match(rendered, new RegExp(toolName));
  }
});

test('renders update transitions and only settled unresolved history', () => {
  const state = createMakaPiTranscriptState();
  replaceTranscriptWithStoredMessages(state, taskMessages('task_update'));
  const tool = onlyTool(state);
  tool.taskMutation = {
    kind: 'found',
    fingerprint: 'update-found',
    presentation: {
      operation: 'update',
      correlation: { turnId: 'turn-1', toolCallId: 'call-1' },
      changes: [
        {
          taskId: 'task-1',
          key: 'T1',
          subject: 'Ship it',
          previousStatus: 'in_progress',
          nextStatus: 'completed',
          evidence: 'Tests passed',
        },
      ],
    },
  };
  tool.taskMutationVersion = 1;
  assert.match(
    plain(renderMakaPiTranscript(state, metadata(), 100)),
    /T1\s+in_progress → completed\s+Ship it — Tests passed/,
  );

  tool.taskMutation = {
    kind: 'unresolved',
    reason: 'not_found',
    observedSettled: false,
    fingerprint: 'unresolved-running',
  };
  tool.taskMutationVersion += 1;
  assert.doesNotMatch(
    plain(renderMakaPiTranscript(state, metadata(), 100)),
    /Task details unavailable/,
  );
  tool.taskMutation = { ...tool.taskMutation, observedSettled: true };
  tool.taskMutationVersion += 1;
  assert.match(plain(renderMakaPiTranscript(state, metadata(), 100)), /Task details unavailable/);
});

function taskMessages(
  toolName: 'task_create' | 'task_update' | 'task_list' | 'task_get',
): StoredMessage[] {
  return [
    {
      type: 'tool_call',
      id: 'call-1',
      turnId: 'turn-1',
      ts: 1,
      toolName,
      args: {},
    },
    {
      type: 'tool_result',
      id: 'result-1',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'call-1',
      isError: false,
      content: { kind: 'text', text: 'done' },
    },
  ];
}

function onlyTool(state: ReturnType<typeof createMakaPiTranscriptState>) {
  const tool = state.entries.find(
    (entry): entry is Extract<(typeof state.entries)[number], { kind: 'tool' }> =>
      entry.kind === 'tool',
  );
  if (!tool) throw new Error('Expected tool entry');
  return tool;
}

function metadata() {
  return {
    title: 'maka',
    cwd: '/repo',
    model: 'model',
    connectionSlug: 'openai',
    permissionMode: 'ask',
  };
}

function plain(lines: readonly string[]): string {
  return lines.join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
