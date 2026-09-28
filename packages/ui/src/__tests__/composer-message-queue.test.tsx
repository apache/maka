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

/** The pending plate's own contract. */

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
  onEditEntry?(entry: Pick<MessageQueueEntryProjection, 'entryId' | 'content'>): void | Promise<void>;
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

test('edit hands the whole entry to its owner and leaves the row to the Host projection', async () => {
  const entry = { ...queued('entry-1', 'first follow-up'), content: { text: 'model text', displayText: 'first follow-up' } };
  const edited: Pick<MessageQueueEntryProjection, 'entryId' | 'content'>[] = [];
  const view = await mountQueue({
    queuedMessages: [entry, queued('entry-2', 'second follow-up')],
    onEditEntry: (target) => {
      edited.push(target);
      return Promise.reject(new Error('retract failed'));
    },
  });
  try {
    await click(actionButton(view.document, copy.editQueuedEntry, 0));
    assert.deepEqual(edited, [entry]);
    assert.equal(view.document.querySelector('textarea'), null, 'there is no in-place editor');
    assert.deepEqual(queueTexts(view.document), ['first follow-up', 'second follow-up']);
  } finally {
    await view.close();
  }
});

test('the plate lists only follow-ups — steering entries belong to the transcript', async () => {
  const dom = installDom();
  try {
    const { projectComposerMessageQueue } = await import('../composer-message-queue.js');
    const steering: MessageQueueEntryProjection = {
      ...queued('entry-0', 'steer the current turn'),
      placement: 'current_turn',
    };
    assert.deepEqual(
      projectComposerMessageQueue([steering, queued('entry-1', 'first follow-up')], [])
        .map((entry) => entry.entryId),
      ['entry-1'],
    );
  } finally {
    dom.restore();
  }
});

test('queue actions stay disabled until the entry is Host-admitted', async () => {
  const pending: MessageQueueEntryProjection[] = [
    { ...queued('entry-1', 'first follow-up'), state: 'in_flight' },
    queued('entry-2', 'second follow-up'),
  ];
  const view = await mountQueue({
    queuedMessages: pending,
    onEditEntry: () => {},
    onDeleteEntry: () => {},
  });
  try {
    const edits = [...view.document.querySelectorAll('button')].filter(
      (button) => (button.getAttribute('aria-label') ?? button.textContent) === copy.editQueuedEntry,
    );
    assert.equal(edits.length, 2);
    // Buttons carrying a tooltip render aria-disabled instead of the native
    // attribute so the tooltip stays reachable — accept either form.
    const isDisabled = (button: HTMLButtonElement) =>
      button.disabled || button.getAttribute('aria-disabled') === 'true';
    assert.deepEqual(edits.map(isDisabled), [true, false], 'only the Host-admitted row is editable');
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
