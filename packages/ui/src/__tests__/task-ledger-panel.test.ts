import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Task } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { deriveTaskLedgerPanelModel, TaskLedgerPanel } from '../task-ledger-panel.js';

function task(input: Partial<Task> & Pick<Task, 'id' | 'key' | 'status'>): Task {
  return {
    subject: input.id,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

describe('task ledger panel model', () => {
  test('keeps terminal ancestors around active descendants', () => {
    const parent = task({ id: 'parent', key: 'T1', status: 'failed', failureReason: 'failed' });
    const child = task({ id: 'child', key: 'T1.1', parentId: parent.id, status: 'pending' });
    const model = deriveTaskLedgerPanelModel([parent, child]);
    assert.equal(model.activeCount, 1);
    assert.deepEqual(model.activeTree.map((item) => item.key), ['T1', 'T1.1']);
  });

  test('selects three recent terminal seeds and adds their ancestors without changing the count', () => {
    const root = task({ id: 'root', key: 'T1', status: 'in_progress' });
    const completedChild = task({
      id: 'child', key: 'T1.1', parentId: root.id, status: 'completed',
      completionEvidence: 'done', endedAt: 5,
    });
    const terminals = [2, 3, 4].map((index) => task({
      id: `terminal-${index}`,
      key: `T${index}`,
      status: 'cancelled',
      endedAt: index,
    }));
    const model = deriveTaskLedgerPanelModel([root, completedChild, ...terminals]);
    assert.equal(model.recentTerminalCount, 3);
    assert.deepEqual(model.recentTerminalTree.map((item) => item.key), ['T1', 'T1.1', 'T3', 'T4']);
  });
});

describe('task ledger disclosure', () => {
  test('delegates the recent-task disclosure and chevron to Astryx without changing the count', () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TaskLedgerPanel, {
        tasks: [
          task({ id: 'active', key: 'T1', status: 'in_progress' }),
          task({ id: 'done', key: 'T2', status: 'completed', endedAt: 2 }),
        ],
      }),
    }));

    assert.match(markup, /class="[^"]*astryx-collapsible[^"]*maka-task-ledger-terminal[^"]*"/);
    const trigger = markup.match(/(<button[^>]*aria-expanded="false"[\s\S]*?<\/button>)/)?.[1] ?? '';
    assert.match(trigger, /最近结束/);
    assert.match(trigger, />1</);
    assert.doesNotMatch(trigger, /lucide-chevron-down/);
  });
});
