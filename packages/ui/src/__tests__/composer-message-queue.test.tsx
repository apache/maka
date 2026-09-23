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

/**
 * The pending plate's own contract. The E2E side-chat failure this replaces
 * hid a queued row behind its own still-open edit box after the Host rejected
 * a stale-revision update, so the row list silently read as reordered.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import { getConversationCopy } from '../conversation-copy.js';
import { installDom } from './mermaid-test-dom.js';

const copy = getConversationCopy('en').composer;

function queued(entryId: string, text: string): MessageQueueEntryProjection {
  return {
    entryId,
    messageId: `msg-${entryId}`,
    content: { text },
    placement: 'next_turn',
    state: 'queued',
  };
}

async function mountQueue(props: {
  queuedMessages: readonly MessageQueueEntryProjection[];
  queueRevision?: number;
  onUpdateEntry?(entryId: string, expectedQueueRevision: number, text: string): void | Promise<void>;
  onDeleteEntry?(entryId: string): void | Promise<void>;
  onPromoteEntry?(entryId: string): void | Promise<void>;
  onReorderEntries?(entryIds: readonly string[]): void | Promise<void>;
}) {
  const dom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { ComposerMessageQueue } = await import('../composer-message-queue.js');
  const root = createRoot(dom.document.getElementById('root')!);
  const render = (next: typeof props) =>
    root.render(createElement(ComposerMessageQueue, { ...next, copy }));
  await act(async () => render(props));
  return {
    document: dom.document,
    async rerender(next: typeof props) {
      await act(async () => render(next));
    },
    async close() {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

function queueTexts(document: Document): string[] {
  return [...document.querySelectorAll('.maka-composer-queue-text')].map(
    (element) => element.textContent ?? '',
  );
}

function actionButton(document: Document, label: string, index = 0): HTMLButtonElement {
  const buttons = [...document.querySelectorAll('button')].filter(
    (button) => (button.getAttribute('aria-label') ?? button.textContent) === label,
  );
  assert.ok(buttons[index], `expected a ${label} action at index ${index}`);
  return buttons[index]!;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
}

test('editing a queued entry reports the captured queue revision and closes on success', async () => {
  const updates: Array<{ entryId: string; revision: number; text: string }> = [];
  const view = await mountQueue({
    queuedMessages: [queued('entry-1', 'first follow-up'), queued('entry-2', 'second follow-up')],
    queueRevision: 7,
    onUpdateEntry: (entryId, expectedQueueRevision, text) => {
      updates.push({ entryId, revision: expectedQueueRevision, text });
    },
  });
  try {
    await click(actionButton(view.document, copy.editQueuedEntry, 0));
    const editor = view.document.querySelector<HTMLTextAreaElement>('textarea.maka-composer-queue-edit');
    assert.ok(editor, 'beginEdit swaps the row into its textarea');
    assert.equal(editor.value, 'first follow-up');
    await view.rerender({
      queuedMessages: [queued('entry-1', 'first follow-up'), queued('entry-2', 'second follow-up')],
      queueRevision: 8,
      onUpdateEntry: (entryId, expectedQueueRevision, text) => {
        updates.push({ entryId, revision: expectedQueueRevision, text });
      },
    });
    await act(async () => {
      editor.value = 'edited first follow-up';
      editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(actionButton(view.document, copy.saveQueuedEntry));
    assert.deepEqual(updates, [{ entryId: 'entry-1', revision: 7, text: 'edited first follow-up' }]);
    assert.equal(view.document.querySelector('textarea.maka-composer-queue-edit'), null);
    assert.deepEqual(queueTexts(view.document), ['first follow-up', 'second follow-up']);
  } finally {
    await view.close();
  }
});

test('a rejected queue edit keeps the row in edit mode instead of reading as reordered', async () => {
  const view = await mountQueue({
    queuedMessages: [
      queued('entry-1', 'first follow-up'),
      queued('entry-2', 'second follow-up'),
      queued('entry-3', 'retract this follow-up'),
    ],
    queueRevision: 3,
    onUpdateEntry: () => Promise.reject(new Error('operation_conflict')),
  });
  try {
    await click(actionButton(view.document, copy.editQueuedEntry, 0));
    const editor = view.document.querySelector<HTMLTextAreaElement>('textarea.maka-composer-queue-edit')!;
    await act(async () => {
      editor.value = 'edited first follow-up';
      editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(actionButton(view.document, copy.saveQueuedEntry));
    assert.deepEqual(
      queueTexts(view.document),
      ['second follow-up', 'retract this follow-up'],
      'the conflicted row is hidden behind its open editor, not dropped or moved',
    );
    assert.equal(
      view.document.querySelector<HTMLTextAreaElement>('textarea.maka-composer-queue-edit')?.value,
      'edited first follow-up',
    );
  } finally {
    await view.close();
  }
});

test('queue actions stay disabled until the entry is Host-admitted', async () => {
  const pending: MessageQueueEntryProjection[] = [
    { ...queued('entry-1', 'first follow-up'), state: 'in_flight' },
    queued('entry-2', 'second follow-up'),
  ];
  const view = await mountQueue({
    queuedMessages: pending,
    queueRevision: undefined,
    onUpdateEntry: () => {},
    onDeleteEntry: () => {},
  });
  try {
    const edits = [...view.document.querySelectorAll('button')].filter(
      (button) => (button.getAttribute('aria-label') ?? button.textContent) === copy.editQueuedEntry,
    );
    assert.equal(edits.length, 2);
    assert.ok(edits.every((button) => button.disabled), 'no row is editable without a queue revision');
  } finally {
    await view.close();
  }
});

test('dragging reorders the Host-owned id list', async () => {
  const reordered: string[][] = [];
  const view = await mountQueue({
    queuedMessages: [
      queued('entry-1', 'first follow-up'),
      queued('entry-2', 'second follow-up'),
      queued('entry-3', 'retract this follow-up'),
    ],
    queueRevision: 1,
    onReorderEntries: (ids) => { reordered.push([...ids]); },
  });
  try {
    const grips = view.document.querySelectorAll('[draggable="true"]');
    const source = grips[1]!;
    const target = view.document.querySelectorAll('[data-maka-queue-drop-target="true"]')[0]!;
    await act(async () => {
      source.dispatchEvent(Object.assign(new window.Event('dragstart', { bubbles: true }), {
        dataTransfer: { effectAllowed: '', setData: () => {} },
      }));
      target.dispatchEvent(new window.Event('drop', { bubbles: true }));
    });
    assert.deepEqual(reordered, [['entry-2', 'entry-1', 'entry-3']]);
  } finally {
    await view.close();
  }
});
