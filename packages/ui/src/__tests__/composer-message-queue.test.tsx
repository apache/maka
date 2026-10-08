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
import type { ComposerQueueEntry } from '../composer-message-queue.js';
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
  queuedMessages: readonly ComposerQueueEntry[];
  queueRevision?: number;
  onEditEntry?(entry: Pick<MessageQueueEntryProjection, 'entryId' | 'content'>): void | Promise<void>;
  onDeleteEntry?(entryId: string): void | Promise<void>;
  onPromoteEntry?(entryId: string): void | Promise<void>;
  onReorderEntries?(
    entryIds: readonly string[], expectedQueueRevision: number,
  ): void | Promise<void>;
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

test('a local pending row exposes only renderer-owned delivery actions', async () => {
  const local: ComposerQueueEntry = {
    ...queued('local', 'pending follow-up'),
    state: 'local',
    localMessage: {
      id: 'msg-local',
      text: 'pending follow-up',
      ts: 1,
      transientPlacement: 'follow_up',
    },
  };
  const view = await mountQueue({
    queuedMessages: [local],
    onEditEntry: () => assert.fail('local rows are not Host-editable'),
    onDeleteEntry: () => assert.fail('local rows are not Host-deletable'),
    onPromoteEntry: () => assert.fail('local rows are not Host-promotable'),
  });
  try {
    const labels = [...view.document.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent,
    );
    assert.equal(labels.includes(copy.editQueuedEntry), false);
    assert.equal(labels.includes(copy.deleteQueuedEntry), false);
    assert.equal(labels.includes(copy.promoteQueuedEntry), false);
  } finally {
    await view.close();
  }
});

test('dragging reorders the Host-owned id list', async () => {
  const reordered: Array<{ ids: readonly string[]; revision: number }> = [];
  const view = await mountQueue({
    queuedMessages: [
      queued('entry-1', 'first follow-up'),
      queued('entry-2', 'second follow-up'),
      queued('entry-3', 'retract this follow-up'),
    ],
    queueRevision: 1,
    onReorderEntries: (ids, revision) => { reordered.push({ ids: [...ids], revision }); },
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
    assert.deepEqual(reordered, [{ ids: ['entry-2', 'entry-1', 'entry-3'], revision: 1 }]);
  } finally {
    await view.close();
  }
});

test('queued entries cannot start a reorder without a Host queue revision', async () => {
  const view = await mountQueue({
    queuedMessages: [queued('entry-1', 'first'), queued('entry-2', 'second')],
    onReorderEntries: () => assert.fail('reorder must remain unavailable'),
  });
  try {
    assert.equal(view.document.querySelectorAll('[draggable="true"]').length, 0);
    assert.equal(view.document.querySelectorAll('[data-maka-queue-drop-target="true"]').length, 0);
  } finally {
    await view.close();
  }
});

test('a drag submits its captured revision so the Host can reject stale order', async () => {
  const reordered: Array<{ ids: string[]; revision: number }> = [];
  const entries = [queued('entry-1', 'first'), queued('entry-2', 'second')];
  const onReorderEntries = (ids: readonly string[], revision: number) => {
    reordered.push({ ids: [...ids], revision });
  };
  const view = await mountQueue({ queuedMessages: entries, queueRevision: 1, onReorderEntries });
  try {
    const source = view.document.querySelectorAll('[draggable="true"]')[1]!;
    await act(async () => {
      source.dispatchEvent(Object.assign(new window.Event('dragstart', { bubbles: true }), {
        dataTransfer: { effectAllowed: '', setData: () => {} },
      }));
    });
    await view.rerender({ queuedMessages: entries, queueRevision: 2, onReorderEntries });
    await act(async () => {
      view.document.querySelectorAll('[data-maka-queue-drop-target="true"]')[0]!
        .dispatchEvent(new window.Event('drop', { bubbles: true }));
    });
    assert.deepEqual(reordered, [{ ids: ['entry-2', 'entry-1'], revision: 1 }]);
  } finally {
    await view.close();
  }
});

test('promote and delete dispatch only for Host-owned queued entries', async () => {
  const promoted: string[] = [];
  const deleted: string[] = [];
  const view = await mountQueue({
    queuedMessages: [
      queued('entry-1', 'first'),
      { ...queued('entry-2', 'second'), state: 'in_flight' },
    ],
    queueRevision: 4,
    onPromoteEntry: (entryId) => { promoted.push(entryId); },
    onDeleteEntry: (entryId) => { deleted.push(entryId); },
  });
  try {
    assert.equal(actionButton(view.document, copy.promoteQueuedEntry, 1).disabled, true);
    assert.equal(
      actionButton(view.document, copy.deleteQueuedEntry, 1).getAttribute('aria-disabled'),
      'true',
    );
    await click(actionButton(view.document, copy.promoteQueuedEntry, 0));
    await click(actionButton(view.document, copy.deleteQueuedEntry, 0));
    assert.deepEqual(promoted, ['entry-1']);
    assert.deepEqual(deleted, ['entry-1']);
  } finally {
    await view.close();
  }
});

test('one render cannot dispatch two mutations for the same pending queue', async () => {
  let settlePromotion!: () => void;
  const promotion = new Promise<void>((resolve) => {
    settlePromotion = resolve;
  });
  const calls: string[] = [];
  const view = await mountQueue({
    queuedMessages: [queued('entry-1', 'first')],
    queueRevision: 4,
    onPromoteEntry: () => {
      calls.push('promote');
      return promotion;
    },
    onDeleteEntry: () => {
      calls.push('delete');
    },
  });
  try {
    const promote = actionButton(view.document, copy.promoteQueuedEntry);
    const remove = actionButton(view.document, copy.deleteQueuedEntry);
    await act(async () => {
      promote.dispatchEvent(new window.Event('click', { bubbles: true }));
      remove.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    assert.deepEqual(calls, ['promote']);
    settlePromotion();
    await act(async () => promotion);
  } finally {
    settlePromotion();
    await view.close();
  }
});
