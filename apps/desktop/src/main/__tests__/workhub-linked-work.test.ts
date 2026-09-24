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

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  workHubLinkedWork,
  workHubTurnResultPreview,
} from "../../renderer/features/workhub/index.js";
import { ChatSurfaceLayout, LocaleProvider } from '@maka/ui';
import { WorkHubConversation, WorkHubDelegationStatus } from '../../renderer/features/workhub/testing.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';
import type { ToolCallMessage, ToolResultMessage } from '@maka/core/session';

test('durable task results restore Host-scoped work links without treating failed or unrelated tools as delegations', () => {
  const target = JSON.stringify(['host-a', 'task-a']);
  const call: ToolCallMessage = { type: 'tool_call', id: 'task-call', turnId: 'turn', ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: {} };
  const result: ToolResultMessage = { type: 'tool_result', id: 'task-result', turnId: 'turn', ts: 2, toolUseId: call.id, isError: false, content: { kind: 'json', value: { disposition: 'create_new', targetSessionKey: target } } };
  const expected = [{ id: result.id, coordinationTurnId: call.turnId, targetSessionId: target, targetSessionName: 'Renamed task', workspaceName: undefined }];
  assert.deepEqual(workHubLinkedWork([call, result], [{ id: target, name: 'Renamed task' }], 'Work'), expected);
  for (const cwd of ['/projects/payments/', 'C:\\projects\\payments\\']) {
    assert.deepEqual(workHubLinkedWork([call, result], [{ id: target, name: 'Renamed task', cwd }], 'Work'), [{ ...expected[0], workspaceName: 'payments' }]);
  }
  assert.deepEqual(workHubLinkedWork([call, { ...result, content: { kind: 'json', value: { content: [], structuredContent: { disposition: 'create_new', targetSessionKey: target } } } }], [{ id: target, name: 'Renamed task' }], 'Work'), expected);
  assert.deepEqual(workHubLinkedWork([call, { ...result, content: { kind: 'text', text: JSON.stringify({ disposition: 'delegate_existing', targetSessionKey: target }) } }], [], 'Work'), [{ ...expected[0], targetSessionName: 'Work' }]);
  assert.deepEqual(workHubLinkedWork([
    call,
    { ...result, isError: true },
    { ...result, toolUseId: 'other-tool' },
    { ...result, content: { kind: 'json', value: { disposition: 'stop_work', targetSessionKey: target } } },
  ], [], 'Work'), []);
});

test('a completed delegation renders only its status beside the prompt timestamp', () => {
  const target = JSON.stringify(['host-a', 'task-a']);
  const markup = renderToStaticMarkup(createElement(WorkHubDelegationStatus, {
    work: {
      id: 'delegation-record',
      coordinationTurnId: 'coordination-turn',
      targetSessionId: target,
      targetSessionName: 'Release checklist',
      targetMessageId: 'delegated-message',
      targetTurnId: 'target-turn',
      state: 'completed',
      resultPreview: 'All release checks passed. The report is ready.',
    },
    locale: 'en',
  }));

  assert.match(markup, /Completed/u);
  assert.doesNotMatch(markup, /All release checks|Open result/u);
});

test('delegated result previews select the exact Turn and stay character-bounded', () => {
  const preview = workHubTurnResultPreview([
    { type: 'assistant', id: 'other-answer', turnId: 'other-turn', ts: 1, modelId: 'model', text: 'wrong result' },
    { type: 'assistant', id: 'target-answer', turnId: 'target-turn', ts: 2, modelId: 'model', text: `  ${'界'.repeat(700)}  ` },
  ], 'target-turn');

  assert.equal(Array.from(preview ?? '').length, 600);
  assert.equal(preview?.endsWith('…'), true);
  assert.doesNotMatch(preview ?? '', /wrong result/u);
});

test('a shared coordination turn keeps every Work label without assigning one Work color to the whole turn', async () => {
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
    createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: 'coordination', name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages: [{ type: 'user', id: 'user', turnId: 'shared', text: 'Do both tasks', ts: 1 }],
      scrollBehavior: 'auto', onNew: () => {}, onOpenWork: () => {},
      workLinks: ['Alpha', 'Beta'].map((name) => ({ id: name, coordinationTurnId: 'shared', targetSessionId: name, targetSessionName: name, workspaceName: 'Workspace' })),
    })),
  ));
  assert.match(markup, /Workspace \/ Alpha/);
  assert.match(markup, /Workspace \/ Beta/);
  assert.doesNotMatch(markup, /data-turn-accent/);
});


test('WorkHub workspace display names handle Host paths independently of renderer platform', async () => {
  const { workspaceNameFromCwd } = await import('../../renderer/features/workhub/testing.js');
  assert.equal(workspaceNameFromCwd('/projects/maka/'), 'maka');
  assert.equal(workspaceNameFromCwd('C:\\projects\\maka\\'), 'maka');
  assert.equal(workspaceNameFromCwd(undefined), undefined);
  assert.equal(workspaceNameFromCwd('/'), undefined);
});
