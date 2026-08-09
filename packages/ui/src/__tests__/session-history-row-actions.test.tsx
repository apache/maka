import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { SessionHistoryList, type SessionRowActions } from '../session-history-list.js';

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
