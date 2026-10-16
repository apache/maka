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
import { ChatSurfaceLayout, LocaleProvider } from '@maka/ui';
import { WorkHubConversation, workHubLinkedWork, workHubTurnContexts } from '../../renderer/features/workhub/testing.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';
import type { StoredMessage, ToolCallMessage, ToolResultMessage, WorkHubDelegationAssignedMessage } from '@maka/core/session';

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


test('WorkHub restores actual answers and accepted handoffs without displaying proposed work as sent', async () => {
  const call: ToolCallMessage = { type: 'tool_call', id: 'question', turnId: 'learn', ts: 2, toolName: 'AskUserQuestion', args: {} };
  const answer: ToolResultMessage = { type: 'tool_result', id: 'answer', turnId: 'learn', ts: 3, toolUseId: call.id, isError: false, content: { kind: 'json', value: { answers: [
    { question: '怎么学？', answer: '直接开练作业' },
    { question: '基础？', answer: '会 Python，但没做过 LLM' },
    { question: '跳过的问题', answer: null },
  ] } } };
  const assignment: WorkHubDelegationAssignedMessage = {
    type: 'workhub_coordination', kind: 'delegation_assigned', schemaVersion: 1,
    id: 'assignment', turnId: 'learn', coordinationTurnId: 'learn', ts: 5,
    actionId: 'action', actionFingerprint: `sha256:${'a'.repeat(64)}`, delegationId: 'delegation',
    targetSessionId: 'target', targetSessionName: 'CS336 学习', targetTurnId: 'target-turn', targetMessageId: 'target-message',
    disposition: 'create_new', userText: '我想学一下 CS336 这门课程',
    delegationText: '用户原话：我想学一下 CS336 这门课程。\n补充选择：直接开练作业；会 Python，但没做过 LLM。',
  };
  const messages: StoredMessage[] = [
    { type: 'user', id: 'user', turnId: 'learn', ts: 1, text: assignment.userText }, call, answer,
    { type: 'tool_call', id: 'proposal', turnId: 'learn', ts: 4, toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation: 'create_new', text: 'UNACCEPTED PROPOSAL' } } },
    assignment,
  ];
  const context = workHubTurnContexts(messages).get('learn')!;
  assert.equal(context.answers.length, 2);
  assert.equal(context.handoffs[0]?.text, assignment.delegationText);
  assert.equal(workHubTurnContexts([call, { ...answer, isError: true }]).size, 0);
  assert.equal(workHubTurnContexts([{ ...call, toolName: 'OtherTool' }, answer]).size, 0);
  assert.equal(workHubTurnContexts([call, { ...answer, turnId: 'other' }]).size, 0);
  assert.equal(workHubTurnContexts([answer]).size, 0);
  assert.deepEqual(workHubTurnContexts([...messages, answer, assignment]), workHubTurnContexts(messages));
  assert.equal(workHubTurnContexts([{ ...assignment, delegationText: undefined }]).get('learn')?.handoffs[0]?.text, assignment.userText);
  assert.equal(workHubTurnContexts([assignment, { ...assignment, id: 'second', delegationText: '第二次交接' }]).get('learn')?.handoffs.length, 2);
  const handoffCall: ToolCallMessage = { ...call, id: 'handoff-call', toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation: 'create_new', title: 'CS336 学习', text: assignment.delegationText } } };
  const receipt = { actionId: assignment.actionId, disposition: 'create_new', targetSessionKey: 'target' };
  const handoffResult: ToolResultMessage = { ...answer, id: 'handoff-result', toolUseId: handoffCall.id, content: { kind: 'json', value: { structuredContent: receipt } } };
  assert.equal(workHubTurnContexts([handoffCall]).size, 0);
  assert.equal(workHubTurnContexts([handoffCall, { ...handoffResult, isError: true }]).size, 0);
  assert.equal(workHubTurnContexts([handoffCall, { ...handoffResult, content: { kind: 'json', value: { kind: 'cancelled' } } }]).size, 0);
  assert.equal(workHubTurnContexts([handoffCall, handoffResult]).get('learn')?.handoffs[0]?.text, assignment.delegationText);
  assert.equal(workHubTurnContexts([handoffCall, handoffResult, assignment]).get('learn')?.handoffs.length, 1);
  assert.equal(workHubTurnContexts([handoffCall, { ...handoffResult, content: { kind: 'text', text: JSON.stringify(receipt) } }]).get('learn')?.handoffs[0]?.text, assignment.delegationText);
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'zh-CN', children: null },
    createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: 'coordination', name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages, workLinks: [], onNew: () => {}, onOpenWork: () => {}, scrollBehavior: 'auto',
    })),
  ));
  const { document } = parseHTML(markup);
  assert.match(document.querySelector('.workhub-clarification-summary')!.textContent!, /直接开练作业/);
  assert.doesNotMatch(document.querySelector('.workhub-turn-context')!.textContent!, /UNACCEPTED PROPOSAL|跳过的问题/);
  assert.equal(document.querySelector('.workhub-handoff'), null);
});


test('task result replies keep their source Work rail even without a new delegation or older history', async () => {
  const target = JSON.stringify(['host-a', 'task-a']);
  const coordination = JSON.stringify(['host-a', 'maka_workhub_coordination']);
  const messages: StoredMessage[] = [
    { type: 'user', id: 'notification', turnId: 'result-turn', ts: 1, text: 'Task result received',
      origin: { kind: 'workhub_result', eventId: 'event', actionId: 'action', delegationId: 'delegation', targetSessionId: 'task-a', targetTurnId: 'task-turn' } },
    { type: 'assistant', id: 'summary', turnId: 'result-turn', ts: 2, text: 'The first exercise is ready.', modelId: 'test' },
  ];
  const links = workHubLinkedWork(messages, [{ id: target, name: 'SQL practice', cwd: '/projects/sql' },
    { id: JSON.stringify(['host-b', 'task-a']), name: 'Other host' }], 'Work', coordination);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.targetSessionId, target);
  assert.equal(links[0]?.coordinationTurnId, 'result-turn');
  assert.equal(links[0]?.workspaceName, 'sql');
  assert.equal(workHubLinkedWork(messages, [], 'Work', coordination)[0]?.targetSessionId, target);
  assert.deepEqual(workHubLinkedWork(messages, [], 'Work'), []);
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
    createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: coordination, name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages, workLinks: links, onNew: () => {}, onOpenWork: () => {}, scrollBehavior: 'auto',
    })),
  ));
  const { document } = parseHTML(markup);
  const rail = document.querySelector('.maka-assistant-answer .workhub-message-rail');
  assert.ok(rail, 'the result reply must have the same clickable rail as its source Work');
  assert.equal(rail.getAttribute('data-work-session-id'), target);
  assert.doesNotMatch(rail.getAttribute('aria-label') ?? '', /Task result received|result-turn/);
});
