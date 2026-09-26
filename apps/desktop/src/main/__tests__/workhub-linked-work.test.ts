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
import { parseHTML } from 'linkedom';
import {
  workHubLinkedWork,
} from "../../renderer/features/workhub/index.js";
import { ChatSurfaceLayout, LocaleProvider } from '@maka/ui';
import { WorkHubConversation } from '../../renderer/features/workhub/testing.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';
import type { ToolCallMessage, ToolResultMessage } from '@maka/core/session';

test('WorkHub uses the common answer footer and failure presentation without prompt status or branch actions', async () => {
  const ts = 1_800_000_000_000;
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
    createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: 'coordination', name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages: [
        { type: 'user', id: 'ask', turnId: 'turn', ts, text: 'Check the task' },
        { type: 'assistant', id: 'answer', turnId: 'turn', ts: ts + 1000, modelId: 'model', text: 'Partial answer' },
        { type: 'turn_state', id: 'failed', turnId: 'turn', ts: ts + 2000, status: 'failed', errorClass: 'auth', failureMessage: 'Provider rejected this credential' },
      ],
      workLinks: [{ id: 'link', coordinationTurnId: 'turn', targetSessionId: 'target', targetSessionName: 'Target task' }],
      onNew: () => {}, onOpenWork: () => {}, scrollBehavior: 'auto',
    })),
  ));
  const { document } = parseHTML(markup);
  const user = document.querySelector('.maka-user-message')!;
  assert.equal(user.querySelectorAll('.workhub-delegation-status, .maka-message-status-time').length, 0);
  assert.ok(user.querySelector('[data-message-id="ask"]'));
  const footer = document.querySelector('.maka-turn-footer')!;
  assert.ok(footer.querySelector('[data-action="copy"]'));
  assert.ok(footer.querySelector('time'));
  assert.equal(footer.querySelectorAll('[data-action="branch"]').length, 0);
  assert.match(document.querySelector('.maka-turn-failed-banner')!.textContent!, /authentication|sign in|credential/i);
});

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

test('a shared coordination turn divides its clickable identity rail equally between Works', async () => {
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
  assert.match(markup, /data-turn-accent="true"/);
  assert.match(markup, /inset-block-start:0%;inset-block-end:auto;height:50%/);
  assert.match(markup, /inset-block-start:50%;inset-block-end:auto;height:50%/);
  assert.match(markup, /Filter conversation by Work: Alpha/);
  assert.match(markup, /Filter conversation by Work: Beta/);
});


test('WorkHub workspace display names handle Host paths independently of renderer platform', async () => {
  const { workspaceNameFromCwd } = await import('../../renderer/features/workhub/testing.js');
  assert.equal(workspaceNameFromCwd('/projects/maka/'), 'maka');
  assert.equal(workspaceNameFromCwd('C:\\projects\\maka\\'), 'maka');
  assert.equal(workspaceNameFromCwd(undefined), undefined);
  assert.equal(workspaceNameFromCwd('/'), undefined);
});


test('stop and resume keep their scoped Session identity through pending, success and failure', () => {
  const target = JSON.stringify(['host-a', 'task-a']);
  const coordination = JSON.stringify(['host-a', 'maka_workhub_coordination']);
  const catalog = [{ id: target, name: 'Login UI', cwd: '/projects/login' }, { id: JSON.stringify(['host-b', 'task-a']), name: 'Other host' }];
  for (const operation of ['stop', 'resume'] as const) {
    const call: ToolCallMessage = { type: 'tool_call', id: operation, turnId: 'control-turn', ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation, targetSessionId: 'task-a' } } };
    const pending = workHubLinkedWork([call], catalog, 'Work', coordination);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.targetSessionId, target);
    const failed: ToolResultMessage = { type: 'tool_result', id: 'failure', turnId: call.turnId, ts: 2, toolUseId: call.id, isError: true, content: { kind: 'text', text: 'Safe-boundary resume is disabled' } };
    const link = workHubLinkedWork([call, failed], catalog, 'Work', coordination)[0]!;
    assert.equal(link.targetSessionId, target);
    const success: ToolResultMessage = { ...failed, isError: false, content: { kind: 'json', value: { disposition: `${operation}_work`, targetSessionKey: target, outcome: operation === 'stop' ? 'stop_delivered' : 'resume_started' } } };
    const links = workHubLinkedWork([call, success], catalog, 'Work', coordination);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.targetSessionId, target);
    assert.deepEqual(workHubLinkedWork([call, failed], catalog, 'Work'), []);
    assert.deepEqual(workHubLinkedWork([{ ...call, toolName: 'unrelated' }, success], catalog, 'Work', coordination), []);
  }
});
