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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
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
import { SessionRailProvider, type SessionRailData } from '../session-rail-context.js';

/**
 * The list reads its rows from `SessionRailData`, so a case states the reading
 * it is about and nothing else.
 */
function Rail(props: Partial<SessionRailData> & { sessions: readonly SessionSummary[] }) {
  const data: SessionRailData = {
    groupVariant: 'conversation',
    onSelectSession: () => undefined,
    ...props,
  };
  return (
    <SessionRailProvider data={data}>
      <SessionHistoryList />
    </SessionRailProvider>
  );
}

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
      <Rail
        sessions={[session]}
        onSelectSession={() => undefined}
        rowActions={rowActions}
      />
    </LocaleProvider>,
  );

  const { document } = parseHTML(markup);
  const sessionRow = document.querySelector('[data-session-id="session-1"]')?.parentElement;
  assert.ok(sessionRow);
  assert.equal(sessionRow.querySelectorAll('button').length, 2);
  assert.ok(sessionRow.querySelector('.maka-session-row-action'));
  assertNoNestedButtons(markup);
});

test('renders a scan-friendly compact timestamp in the session rail', () => {
  const now = Date.UTC(2026, 7, 24, 12, 0, 0);
  const originalDateNow = Date.now;
  Date.now = () => now;
  try {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <Rail
          sessions={[{ ...session, lastMessageAt: now - 46 * 60_000 }]}
          onSelectSession={() => undefined}
        />
      </LocaleProvider>,
    );
    const { document } = parseHTML(markup);

    assert.equal(document.querySelector('.maka-session-row-time-label')?.textContent, '46min');
  } finally {
    Date.now = originalDateNow;
  }
});

test('renders Runtime Host live runs without requiring renderer-local streaming', () => {
  const hostRunning = { ...session, runningTurnIds: ['turn-live'] };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
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
        <Rail
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
      <Rail
        sessions={[knownEmpty]}
        onSelectSession={() => undefined}
        rowActions={rowActions}
      />
    </LocaleProvider>,
  );
  const locallyStreamingMarkup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
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
      <Rail
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
  assert.ok(navigation.querySelector('.lucide-folder-open'));
  assert.equal(navigation.getAttribute('data-maka-project-disclosure'), 'true');
  const projectButtons = [...projectRow.querySelectorAll('button')];
  assert.equal(
    projectButtons.indexOf(navigation),
    0,
    'project navigation precedes its auxiliary action',
  );
  assert.equal(projectButtons.indexOf(action), 1, 'project action precedes nested tasks');
  assertNoNestedButtons(markup);
});

test('project grouping renders pinned tasks under a Pinned heading', () => {
  const pinned = { ...session, id: 'session-pinned', name: 'Pinned task', isFlagged: true };
  const recent = { ...session, id: 'session-recent', name: 'Recent task' };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
        sessions={[pinned, recent]}
        groups={[{ id: project.id, label: project.name, project, sessions: [pinned, recent] }]}
        groupVariant="project"
        projectActions={projectActions}
        onSelectSession={() => undefined}
      />
    </LocaleProvider>,
  );

  const { document } = parseHTML(markup);
  const sectionTitles = [
    ...document.querySelectorAll<HTMLButtonElement>('.maka-session-group-toggle'),
  ].map((toggle) => toggle.textContent);
  const pinnedSection = document.querySelector('.maka-session-group');
  const projectRow = document.querySelector('.maka-project-row');

  assert.deepEqual(sectionTitles, ['Pinned', 'Projects']);
  assert.ok(pinnedSection);
  assert.equal(pinnedSection.querySelector(':scope > :first-child')?.textContent, 'Pinned');
  assert.ok(pinnedSection.querySelector('[data-session-id="session-pinned"]'));
  assert.ok(projectRow);
  assert.equal(projectRow.querySelector('[data-session-id="session-pinned"]'), null);
  assert.ok(projectRow.querySelector('[data-session-id="session-recent"]'));
  assert.equal(projectRow.querySelector('.maka-project-item-end')?.textContent, '1');
});

test('project grouping renders archived projects under the shared section heading', () => {
  const archivedProject = { ...project, id: 'project-archived', archivedAt: 1 };
  const archivedSession = { ...session, id: 'session-archived', projectId: archivedProject.id };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
        sessions={[session, archivedSession]}
        groups={[
          { id: project.id, label: project.name, project, sessions: [session] },
          {
            id: archivedProject.id,
            label: 'Archived Maka',
            project: archivedProject,
            sessions: [archivedSession],
          },
        ]}
        groupVariant="project"
        projectActions={projectActions}
        onSelectSession={() => undefined}
      />
    </LocaleProvider>,
  );

  const { document } = parseHTML(markup);
  const sectionTitles = [
    ...document.querySelectorAll<HTMLButtonElement>('.maka-session-group-toggle'),
  ].map((toggle) => toggle.textContent);
  const archivedSection = [
    ...document.querySelectorAll<HTMLElement>('.maka-session-group'),
  ].find((section) => section.querySelector('.maka-session-group-toggle')?.textContent === 'Archived projects');

  assert.deepEqual(sectionTitles, ['Projects', 'Archived projects']);
  assert.ok(archivedSection);
  assert.ok(archivedSection.querySelector('[data-project-id="project-archived"]'));
});

test('section headings toggle their rows and expose disclosure state', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const pinned = { ...session, id: 'session-pinned', isFlagged: true };
  const recent = { ...session, id: 'session-recent' };

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Rail sessions={[pinned, recent]} rowActions={rowActions} />
      </LocaleProvider>,
    ));

    const toggles = [
      ...container.querySelectorAll<HTMLButtonElement>('.maka-session-group-toggle'),
    ];
    assert.deepEqual(toggles.map((toggle) => toggle.textContent), ['Pinned', 'Recent']);
    const pinnedToggle = toggles[0];
    assert.ok(pinnedToggle);
    assert.equal(pinnedToggle.getAttribute('aria-expanded'), 'true');
    assert.ok(pinnedToggle.querySelector('.maka-session-group-chevron'));
    const contentId = pinnedToggle.getAttribute('aria-controls');
    assert.ok(contentId);
    const content = document.getElementById(contentId);
    assert.ok(content);
    assert.equal(content.getAttribute('aria-hidden'), 'false');

    await act(() => {
      pinnedToggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    assert.equal(pinnedToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(content.getAttribute('aria-hidden'), 'true');
    assert.equal(content.hasAttribute('inert'), true);
    assert.equal(content.getAttribute('data-collapsed'), 'true');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});

test('omits a zero count on empty projects', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
        sessions={[]}
        groups={[{ id: project.id, label: project.name, project, sessions: [] }]}
        groupVariant="project"
        projectActions={projectActions}
        onSelectSession={() => undefined}
      />
    </LocaleProvider>,
  );

  const { document } = parseHTML(markup);
  const metadata = document.querySelector('.maka-project-item-end');
  assert.ok(metadata);
  assert.equal(metadata.textContent, '');
});
