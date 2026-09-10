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
} from "../../renderer/features/workhub/index.js";
import { getWorkHubRailCopy } from "../../renderer/locales/workhub-copy.js";
import type { ToolCallMessage, ToolResultMessage } from '@maka/core/session';

test('durable task results restore Host-scoped work links without treating failed or unrelated tools as delegations', () => {
  const target = JSON.stringify(['host-a', 'task-a']);
  const call: ToolCallMessage = { type: 'tool_call', id: 'task-call', turnId: 'turn', ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: {} };
  const result: ToolResultMessage = { type: 'tool_result', id: 'task-result', turnId: 'turn', ts: 2, toolUseId: call.id, isError: false, content: { kind: 'json', value: { disposition: 'create_new', targetSessionKey: target } } };
  const expected = [{ id: result.id, coordinationTurnId: call.turnId, targetSessionId: target, targetSessionName: 'Renamed task' }];
  assert.deepEqual(workHubLinkedWork([call, result], [{ id: target, name: 'Renamed task' }], 'Work'), expected);
  assert.deepEqual(workHubLinkedWork([call, { ...result, content: { kind: 'json', value: { content: [], structuredContent: { disposition: 'create_new', targetSessionKey: target } } } }], [{ id: target, name: 'Renamed task' }], 'Work'), expected);
  assert.deepEqual(workHubLinkedWork([call, { ...result, content: { kind: 'text', text: JSON.stringify({ disposition: 'delegate_existing', targetSessionKey: target }) } }], [], 'Work'), [{ ...expected[0], targetSessionName: 'Work' }]);
  assert.deepEqual(workHubLinkedWork([
    call,
    { ...result, isError: true },
    { ...result, toolUseId: 'other-tool' },
    { ...result, content: { kind: 'json', value: { disposition: 'stop_work', targetSessionKey: target } } },
  ], [], 'Work'), []);
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
    onOpenSession: () => undefined,
  }));

  assert.match(markup, /8\/20 anchors · 20 total/u);
  assert.equal(markup.match(/<li[ >]/gu)?.length, 8);
});


test("focus display is derived from the selected Session ID, not delegation priority", () => {
  const markup = renderToStaticMarkup(createElement(WorkHubNavigationRail, {
    locale: "en", sessions, focusSessionId: "focus", delegatedSessionIds: ["delegated"],
    copy: getWorkHubRailCopy("en"), onOpenSession: () => undefined,
  }));
  assert.equal(markup.match(/aria-current="page"/gu)?.length, 1);
  assert.equal(markup.match(/Focused · Running/gu)?.length, 1);
});
