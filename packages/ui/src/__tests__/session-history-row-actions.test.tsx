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
  assert.doesNotMatch(markup, /<button\b(?:(?!<\/button>)[\s\S])*<button\b/);
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
  assert.equal(projectButtons[0], action);
  assert.equal(projectButtons[1], navigation);
  assert.doesNotMatch(markup, /<button\b(?:(?!<\/button>)[\s\S])*<button\b/);
});
