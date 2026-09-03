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

/** The list's top-level `SideNavSection`s, in document order, by their title. */
function readSections(document: Document): Array<{ title: string; element: Element }> {
  return [...document.querySelectorAll('.maka-session-list > [role="group"]')].map((element) => {
    const labelId = element.getAttribute('aria-labelledby');
    return {
      title: (labelId ? document.getElementById(labelId)?.textContent : undefined) ?? '',
      element,
    };
  });
}

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

function assertDescriptionReferencesResolve(markup: string): void {
  const { document } = parseHTML(markup);
  for (const element of document.querySelectorAll<HTMLElement>(
    'button.astryx-side-nav-item[aria-describedby]',
  )) {
    const describedBy = element.getAttribute('aria-describedby');
    assert.ok(describedBy);
    for (const id of describedBy.split(/\s+/)) {
      const description = document.getElementById(id);
      assert.ok(
        description,
        `aria-describedby token ${JSON.stringify(id)} must resolve while the card is closed`,
      );
      assert.equal(
        description.textContent,
        '',
        'the stable description must not duplicate session or project content into DOM text queries',
      );
      assert.ok(
        description.getAttribute('aria-label'),
        'the stable description keeps its accessible text through aria-label',
      );
    }
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

  assert.equal((markup.match(/<button\b/g) ?? []).length, 2);
  assert.match(markup, /class="maka-session-row-action"/);
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

test('wires the session navigation control to its hover card description', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
        sessions={[session]}
        onSelectSession={() => undefined}
      />
    </LocaleProvider>,
  );
  const { document } = parseHTML(markup);
  const navigation = document.querySelector<HTMLButtonElement>(
    '.maka-session-row .astryx-side-nav-item',
  );

  assert.ok(navigation);
  assert.ok(navigation.getAttribute('aria-describedby'));
  assertDescriptionReferencesResolve(markup);
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
  assert.equal(metadata.textContent, '');
  assert.equal(navigation.textContent, 'Maka', 'project navigation omits the task-count badge');
  assert.equal(controlledGroup.getAttribute('aria-hidden'), 'false');
  const projectButtons = [...projectRow.querySelectorAll('button')];
  assert.equal(
    projectButtons.indexOf(navigation),
    0,
    'project navigation precedes its auxiliary action',
  );
  assert.equal(projectButtons.indexOf(action), 1, 'project action precedes nested tasks');
  assert.ok(navigation.getAttribute('aria-describedby'));
  assertDescriptionReferencesResolve(markup);
  assertNoNestedButtons(markup);
});

test('renders pinned tasks once above project groups', () => {
  const pinnedSession: SessionSummary = {
    ...session,
    id: 'session-pinned',
    name: 'Pinned task',
    isFlagged: true,
  };
  const projectSession: SessionSummary = {
    ...session,
    id: 'session-project',
    name: 'Project task',
  };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
        sessions={[pinnedSession, projectSession]}
        groups={[
          {
            id: project.id,
            label: project.name,
            project,
            sessions: [pinnedSession, projectSession],
          },
        ]}
        groupVariant="project"
      />
    </LocaleProvider>,
  );

  const { document } = parseHTML(markup);
  const sections = readSections(document);
  assert.deepEqual(
    sections.map((section) => section.title),
    ['Pinned', 'Projects'],
    'pinned tasks and project rows are sibling sections, not a section beside bare items',
  );
  const [pinned, projects] = sections;
  assert.ok(pinned && projects);
  assert.equal(markup.match(/Pinned task/g)?.length, 1);
  assert.match(pinned.element.textContent, /Pinned task/);
  assert.doesNotMatch(projects.element.textContent, /Pinned task/);
  const projectRow = projects.element.querySelector('.maka-project-row');
  assert.ok(projectRow, 'project rows are items inside the Projects section');
  assert.match(projectRow.textContent, /Project task/);
});

test('a project whose only task is pinned describes itself as empty', () => {
  const pinnedSession: SessionSummary = {
    ...session,
    id: 'session-pinned',
    name: 'Pinned task',
    isFlagged: true,
  };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
        sessions={[pinnedSession]}
        groups={[{ id: project.id, label: project.name, project, sessions: [pinnedSession] }]}
        groupVariant="project"
        projectActions={projectActions}
      />
    </LocaleProvider>,
  );

  const { document } = parseHTML(markup);
  const projectRow = document.querySelector('.maka-project-row');
  assert.ok(projectRow);
  const navigation = projectRow.querySelector<HTMLButtonElement>(':scope > div > button');
  assert.ok(navigation);
  assert.equal(navigation.getAttribute('aria-controls'), null, 'no disclosure without a subtree');
  const describedBy = navigation.getAttribute('aria-describedby');
  assert.ok(describedBy);
  const description = document.getElementById(describedBy);
  assert.ok(description);
  assert.match(
    description.getAttribute('aria-label') ?? '',
    /\b0 tasks\b/,
    'the hover description counts what the row actually shows',
  );
  const action = document.querySelector('button[aria-label="Maka project actions"]');
  assert.ok(action);
});

test('keeps project running totals aligned with renderer-local task streaming', () => {
  const locallyStreaming = {
    ...session,
    status: 'active' as const,
    runningTurnIds: [] as string[],
  };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Rail
        sessions={[locallyStreaming]}
        groups={[
          {
            id: project.id,
            label: project.name,
            project,
            sessions: [locallyStreaming],
          },
        ]}
        groupVariant="project"
        streamingSessionIds={new Set([locallyStreaming.id])}
      />
    </LocaleProvider>,
  );
  const { document } = parseHTML(markup);
  const projectNavigation = document.querySelector<HTMLButtonElement>(
    '.maka-project-row > div > .astryx-side-nav-item',
  );
  const descriptionId = projectNavigation?.getAttribute('aria-describedby');
  const description = descriptionId ? document.getElementById(descriptionId) : null;

  assert.match(markup, /aria-label="Responding"/);
  assert.ok(description);
  assert.match(description.getAttribute('aria-label') ?? '', /1 running/);
});
