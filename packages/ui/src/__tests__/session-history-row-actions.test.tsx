import assert from 'node:assert/strict';
import test from 'node:test';
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
  locations: [],
  available: true,
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

test('renders project navigation and row actions as sibling controls', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionHistoryList
        sessions={[session]}
        groups={[{ id: project.id, label: project.name, sessions: [session], project }]}
        groupVariant="project"
        onSelectSession={() => undefined}
        projectActions={projectActions}
      />
    </LocaleProvider>,
  );

  assert.equal((markup.match(/<button\b/g) ?? []).length, 3);
  assert.match(markup, /data-has-sessions="true"/);
  assert.match(markup, /class="maka-project-row-action"/);
  assert.doesNotMatch(markup, /<button\b(?:(?!<\/button>)[\s\S])*<button\b/);
  const projectRowStart = markup.indexOf('data-project-id="project-1"');
  const projectAction = markup.indexOf('class="maka-project-row-action"', projectRowStart);
  const projectSessions = markup.indexOf('role="group"', projectRowStart);
  assert.ok(
    projectRowStart >= 0 && projectAction > projectRowStart && projectAction < projectSessions,
    'project actions should precede nested sessions in the DOM and keyboard order',
  );
});
