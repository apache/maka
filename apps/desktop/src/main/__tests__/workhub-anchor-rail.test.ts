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
import type { WorkHubAnchorSession } from "../../renderer/features/workhub/index.js";
import {
  deriveWorkHubAnchors,
  matchesWorkHubFilter,
  MAX_WORKHUB_ANCHORS,
  WorkHubNavigationRail,
  workHubLinkedWork,
  workHubTurnResultPreview,
} from "../../renderer/features/workhub/index.js";
import { ChatSurfaceLayout, LocaleProvider } from '@maka/ui';
import { WorkHubConversation, WorkHubDelegationStatus } from '../../renderer/features/workhub/testing.js';
import { getWorkHubRailCopy } from "../../renderer/locales/workhub-copy.js";
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

function session(
  sessionId: string,
  state: WorkHubAnchorSession["state"],
  updatedAt: number,
  archived = false,
): WorkHubAnchorSession {
  return {
    target: { sessionId },
    projectName: "Maka",
    sessionName: sessionId,
    archived,
    state,
    updatedAt,
  };
}

const sessions = [
  session("recent", "active", 100),
  session("focus", "running", 10),
  session("delegated", "waiting_for_user", 20),
  session("blocked", "blocked", 90),
  session("stopped", "aborted", 80),
  session("archived", "active", 110, true),
];

test("anchors prioritize focus and delegation before recent Session facts", () => {
  const before = structuredClone(sessions);
  const anchors = deriveWorkHubAnchors({
    sessions,
    focusSessionId: "focus",
    delegatedSessionIds: ["delegated", "focus", "missing"],
    filter: "all",
  });
  assert.deepEqual(sessions, before);
  assert.deepEqual(anchors.map((value) => value.target.sessionId),
    ["focus", "delegated", "archived", "recent", "blocked", "stopped"]);
  assert.deepEqual(deriveWorkHubAnchors({ sessions, delegatedSessionIds: ["delegated"], filter: "all" })[0], sessions[2]);
});

test("filters are derived from Session state and archive facts only", () => {
  assert.deepEqual(
    sessions
      .filter((value) => matchesWorkHubFilter(value, "active"))
      .map((value) => value.target.sessionId),
    ["recent", "focus"],
  );
  assert.deepEqual(
    sessions
      .filter((value) => matchesWorkHubFilter(value, "attention"))
      .map((value) => value.target.sessionId),
    ["delegated", "blocked"],
  );
  assert.deepEqual(
    sessions
      .filter((value) => matchesWorkHubFilter(value, "stopped"))
      .map((value) => value.target.sessionId),
    ["stopped", "archived"],
  );
});

test("anchor projection is deduplicated and hard-bounded", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    session(`session-${index}`, "active", index),
  );
  const anchors = deriveWorkHubAnchors({
    sessions: [...many, many[0]!, many[4]!],
    delegatedSessionIds: [...many, many[0]!].map((value) => value.target.sessionId),
    filter: "all",
  });
  assert.equal(anchors.length, MAX_WORKHUB_ANCHORS);
  assert.equal(
    new Set(anchors.map((value) => value.target.sessionId)).size,
    anchors.length,
  );
});

test("rail copy distinguishes bounded anchors from all matching work", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    session(`session-${index}`, "active", index),
  );
  const markup = renderToStaticMarkup(createElement(WorkHubNavigationRail, {
    locale: "en",
    sessions: many,
    delegatedSessionIds: [],
    copy: getWorkHubRailCopy("en"),
  }));

  assert.match(markup, /8\/20 anchors · 20 total/u);
  assert.equal(markup.match(/<li[ >]/gu)?.length, 8);
});


test("focus display is derived from the selected Session ID, not delegation priority", () => {
  const markup = renderToStaticMarkup(createElement(WorkHubNavigationRail, {
    locale: "en", sessions, focusSessionId: "focus", delegatedSessionIds: ["delegated"],
    copy: getWorkHubRailCopy("en"),
  }));
  assert.equal(markup.match(/aria-current="page"/gu)?.length, 1);
  assert.equal(markup.match(/Focused · Running/gu)?.length, 1);
});


test('a shared coordination turn keeps every Work label without assigning one Work color to the whole turn', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
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
