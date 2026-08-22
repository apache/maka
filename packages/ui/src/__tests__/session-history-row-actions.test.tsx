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
import { parseHTML } from 'linkedom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider } from '../locale-context.js';
import {
  SessionHistoryList,
  type ProjectRowActions,
  type SessionRowActions,
} from '../session-history-list.js';

const session: SessionSummary = {
  id: 'session-1',
  name: 'Release notes',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  backend: 'ai-sdk',
  llmConnectionSlug: 'test-connection',
  connectionLocked: true,
  model: 'test-model',
  permissionMode: 'ask',
};

const rowActions: SessionRowActions = {
  onToggleFlag: () => undefined,
  onArchive: () => undefined,
  onUnarchive: () => undefined,
  onRename: () => undefined,
  onDelete: () => undefined,
};

const project: ProjectRecord = {
  id: 'project-1',
  name: 'Maka',
  locations: [{ path: '/workspace/maka', isWorktree: false }],
  available: true,
  preferredPath: '/workspace/maka',
};

const projectActions: ProjectRowActions = {
  onNew: () => undefined,
  onRename: () => undefined,
  onArchive: () => undefined,
  onRestore: () => undefined,
};

function assertNoNestedButtons(markup: string): void {
  // Structural check. A real regression here moves the action menu inside the
  // navigation control, and the menu always ships wrapped in
  // `.maka-session-row-action`, so the nesting survives parsing and is caught.
  const { document } = parseHTML(markup);
  assert.equal(
    document.querySelector('button button') === null,
    true,
    'navigation and action controls must stay siblings',
  );

  // `parseHTML` auto-closes a `<button>` that opens directly inside another,
  // which the structural check above then cannot see. Count start and end tags
  // on the raw markup to cover that shape too. Single-token match, so this
  // stays linear and cannot backtrack the way an enclosing-pair regex would.
  let depth = 0;
  for (const [, slash] of markup.matchAll(/<(\/?)button\b/g)) {
    depth += slash === '/' ? -1 : 1;
    assert.ok(depth <= 1, 'markup must not open a <button> inside another');
  }
}

test('renders session navigation and row actions as sibling controls', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionHistoryList
        sessions={[session]}
        onSelectSession={() => undefined}
        rowActions={rowActions}
      />
    </LocaleProvider>,
  );

  assert.equal((markup.match(/<button\b/g) ?? []).length, 2);
  assert.match(markup, /class="maka-session-row-action"/);
  assertNoNestedButtons(markup);
});

test('renders Runtime Host live runs without requiring renderer-local streaming', () => {
  const hostRunning = { ...session, runningTurnIds: ['turn-live'] };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionHistoryList
        sessions={[hostRunning]}
        onSelectSession={() => undefined}
        rowActions={rowActions}
      />
    </LocaleProvider>,
  );

  assert.match(markup, /aria-label="Responding"/);
});

for (const [status, attentionLabel] of [
  ['waiting_for_user', 'Waiting for you'],
  ['blocked', 'Needs attention'],
] as const) {
  test(`prioritizes ${status} attention over a parked live run`, () => {
    const awaitingUser = { ...session, status, runningTurnIds: ['turn-live'] };
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SessionHistoryList
          sessions={[awaitingUser]}
          streamingSessionIds={new Set([awaitingUser.id])}
          onSelectSession={() => undefined}
          rowActions={rowActions}
        />
      </LocaleProvider>,
    );

    assert.doesNotMatch(markup, /aria-label="Responding"/);
    assert.match(markup, new RegExp(`aria-label="${attentionLabel}"`));
  });
}

test('keeps known-empty idle unless renderer-local streaming is newer', () => {
  const knownEmpty = { ...session, status: 'running' as const, runningTurnIds: [] as string[] };
  const idleMarkup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionHistoryList
        sessions={[knownEmpty]}
        onSelectSession={() => undefined}
        rowActions={rowActions}
      />
    </LocaleProvider>,
  );
  const locallyStreamingMarkup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionHistoryList
        sessions={[knownEmpty]}
        streamingSessionIds={new Set([knownEmpty.id])}
        onSelectSession={() => undefined}
        rowActions={rowActions}
      />
    </LocaleProvider>,
  );

  assert.doesNotMatch(idleMarkup, /aria-label="Responding"/);
  assert.doesNotMatch(idleMarkup, /aria-label="Running"/);
  assert.match(locallyStreamingMarkup, /aria-label="Responding"/);
});

test('renders collapsible project navigation and row actions as sibling controls', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionHistoryList
        sessions={[session]}
        groups={[{ id: project.id, label: project.name, project, sessions: [session] }]}
        groupVariant="project"
        projectActions={projectActions}
        onSelectSession={() => undefined}
      />
    </LocaleProvider>,
  );

  const { document } = parseHTML(markup);
  const projectRow = document.querySelector('.maka-project-row');
  const action = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Maka project actions"]',
  );

  assert.ok(projectRow);
  assert.ok(action);
  const navigation = projectRow.querySelector<HTMLButtonElement>(
    ':scope > div > button[aria-controls]',
  );
  const metadata = projectRow.querySelector('.maka-project-item-end');
  const controlledGroupId = navigation?.getAttribute('aria-controls');
  const controlledGroup = controlledGroupId
    ? document.getElementById(controlledGroupId)
    : null;

  assert.ok(navigation);
  assert.ok(metadata);
  assert.ok(controlledGroup);
  assert.equal(navigation.contains(metadata), true);
  assert.equal(navigation.contains(action), false);
  assert.equal(metadata.textContent, '1');
  assert.equal(controlledGroup.getAttribute('aria-hidden'), 'false');
  const projectButtons = [...projectRow.querySelectorAll('button')];
  assert.equal(
    projectButtons.indexOf(navigation),
    0,
    'project navigation precedes its auxiliary action',
  );
  assert.equal(projectButtons.indexOf(action), 1, 'project action precedes nested tasks');
  assertNoNestedButtons(markup);
});
