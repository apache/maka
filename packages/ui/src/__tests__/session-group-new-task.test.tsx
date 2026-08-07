import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { SessionHistoryList } from '../session-history-list.js';

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    name: overrides.id,
    status: 'active',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: 1,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
    ...overrides,
  };
}

function renderHistory(props: {
  locale: 'zh' | 'en';
  sessions: SessionSummary[];
  onNewTask?: () => void;
  groupVariant?: 'conversation' | 'project';
}): string {
  return renderToStaticMarkup(
    <LocaleProvider locale={props.locale}>
      <SessionHistoryList
        sessions={props.sessions}
        groupVariant={props.groupVariant}
        onSelectSession={() => {}}
        onNewTask={props.onNewTask}
      />
    </LocaleProvider>,
  );
}

const MIXED = [
  session({ id: 'pinned-1', name: 'cli-chat', isFlagged: true, lastMessageAt: 3 }),
  session({ id: 'recent-1', name: '你好呀', lastMessageAt: 2 }),
  session({ id: 'recent-2', name: 'Deep Research', lastMessageAt: 1 }),
];

describe('session group new-task trigger', () => {
  it('puts one trigger on each labeled group in time view', () => {
    const markup = renderHistory({ locale: 'en', sessions: MIXED, onNewTask: () => {} });

    // One trigger per labeled group: Pinned + Recent.
    assert.equal(markup.match(/maka-group-new-task-button/g)?.length, 2);
    assert.equal(markup.match(/aria-label="New task in group"/g)?.length, 2);
    // The trigger must NOT reuse the rail row's accessible name ("New task"):
    // two same-named buttons are a strict-mode violation for
    // getByRole('button', { name }) and an ambiguity for screen readers.
    assert.doesNotMatch(markup, /aria-label="New task"/);
  });

  it('localizes the accessible name with the group-specific new-task copy', () => {
    const zh = renderHistory({ locale: 'zh', sessions: MIXED, onNewTask: () => {} });
    assert.equal(zh.match(/aria-label="新建任务"/g)?.length, 2);
    // 新建任务 must stay distinct from the rail row's 新任务 (see above).
    assert.doesNotMatch(zh, /aria-label="新任务"/);
  });

  it('stays absent without an onNewTask handler', () => {
    const markup = renderHistory({ locale: 'en', sessions: MIXED });
    assert.doesNotMatch(markup, /maka-group-new-task-button/);
  });

  it('stays out of the project grouping, whose rows carry their own new-task menu', () => {
    const markup = renderHistory({
      locale: 'en',
      sessions: MIXED,
      groupVariant: 'project',
      onNewTask: () => {},
    });
    assert.doesNotMatch(markup, /maka-group-new-task-button/);
  });

  it('skips an unlabeled group, which has no title row to carry the trigger', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SessionHistoryList
          sessions={MIXED}
          groups={[{ id: 'plain', label: '', sessions: MIXED }]}
          onSelectSession={() => {}}
          onNewTask={() => {}}
        />
      </LocaleProvider>,
    );
    assert.doesNotMatch(markup, /maka-group-new-task-button/);
  });
});
