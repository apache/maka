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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider, SessionRailProvider } from '@maka/ui';
import { SessionHistoryList } from '@maka/ui/testing';
import { deriveSessionRail } from '../../renderer/features/session-navigation/testing.js';

const root: SessionSummary = {
  id: 'root', name: 'Swarm graph', isFlagged: false, isArchived: false, labels: [],
  hasUnread: false, status: 'active', backend: 'ai-sdk', llmConnectionSlug: 'test',
  connectionLocked: true, model: 'test', permissionMode: 'ask', orchestrationMode: 'swarm',
};

function renderRail(parent: SessionSummary, childRunning = false, streaming = false) {
  const children = Array.from({ length: 3 }, (_, index): SessionSummary => ({
    ...root, id: `child-${index}`, name: `Child ${index}`,
    runningTurnIds: childRunning ? [`child-turn-${index}`] : [],
    subagent: { parentSessionId: root.id, agentId: `agent-${index}`, agentName: `Agent ${index}` },
  }));
  const rail = deriveSessionRail([parent, ...children], parent.id, () => true);
  const markup = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', children:
    createElement(SessionRailProvider, { data: {
      sessions: rail.sessions, activeId: rail.activeRowId,
      groupVariant: 'project', groups: [{ id: 'project', label: 'Project', sessions: rail.sessions }],
      streamingSessionIds: streaming ? new Set([parent.id]) : new Set<string>(),
      onSelectSession() {},
    } }, createElement(SessionHistoryList)) }));
  const { document } = parseHTML(markup);
  const rows = document.querySelectorAll('.maka-session-row');
  assert.equal(rows.length, 1, 'linked graph children remain off the rail');
  assert.equal(rows[0]?.getAttribute('data-session-id'), parent.id);
  const dot = document.querySelector('.maka-session-row-signal .maka-running-indicator, .maka-session-row-signal [role="img"]');
  const label = dot?.getAttribute('aria-label') ?? dot?.querySelector('.maka-visually-hidden')?.textContent;
  return { dot, label, markup };
}

test('the real rail shows running activity across root dispatch, graph yield, root summary, then settles', () => {
  const stages = [
    { runningTurnIds: ['dispatch'], backgroundActivity: 'idle', childRunning: false, label: 'Responding' },
    { runningTurnIds: [], backgroundActivity: 'running', childRunning: true, label: 'Subtasks running' },
    { runningTurnIds: ['summary'], backgroundActivity: 'idle', childRunning: false, label: 'Responding' },
    { runningTurnIds: [], backgroundActivity: 'idle', childRunning: false, label: undefined },
  ] as const;
  let runningClass: string | null = null;
  for (const stage of stages) {
    const { dot, label, markup } = renderRail({ ...root,
      runningTurnIds: [...stage.runningTurnIds], backgroundActivity: stage.backgroundActivity,
    }, stage.childRunning);
    if (stage.label) {
      assert.equal(label, stage.label);
      assert.ok(dot?.classList.contains('maka-running-indicator'));
      runningClass ??= dot!.getAttribute('class');
      assert.equal(dot?.getAttribute('class'), runningClass, 'background uses the same running indicator as a live root');
      assert.match(markup, /1 running/);
    } else {
      assert.equal(dot, null, 'only the authoritative settled snapshot removes the dot');
      assert.doesNotMatch(markup, /1 running/);
    }
  }
});

test('background questions need attention while the root may handle a failed child', () => {
  const waiting = renderRail({ ...root, runningTurnIds: ['root-turn'], backgroundActivity: 'waiting_for_user' });
  assert.equal(waiting.label, 'Subtasks waiting for you');
  assert.doesNotMatch(waiting.markup, /1 running/);
  const blocked = renderRail({ ...root, runningTurnIds: [], backgroundActivity: 'blocked' });
  assert.equal(blocked.label, 'Subtasks need attention');
  assert.doesNotMatch(blocked.markup, /1 running/);
  const recovering = renderRail({ ...root, runningTurnIds: ['summary'], backgroundActivity: 'blocked' });
  assert.equal(recovering.label, 'Responding');
  assert.match(recovering.markup, /1 running/);
  const ownWaiting = renderRail({ ...root, status: 'waiting_for_user', runningTurnIds: ['root-turn'], backgroundActivity: 'running' });
  assert.equal(ownWaiting.label, 'Waiting for you');
  assert.doesNotMatch(ownWaiting.markup, /1 running/);
});

test('renderer streaming still fills the catalog gap without inventing background activity', () => {
  const { label } = renderRail({ ...root, runningTurnIds: [], backgroundActivity: 'idle' }, false, true);
  assert.equal(label, 'Responding');
  assert.equal(renderRail({ ...root, runningTurnIds: [] }).dot, null);
});
