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
import type { ComposerMessageQueueProps } from '../composer-message-queue.js';
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

async function mountQueue(props: Omit<ComposerMessageQueueProps, 'copy'>) {
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

test('local delivery actions suppress activation while disabled and become usable again', async () => {
  const { projectComposerMessageQueue } = await import('../composer-message-queue.js');
  const label = 'Edit and resend';
  for (const placement of ['current_turn', 'next_turn'] as const) {
    let calls = 0;
    const pending = (disabled: boolean) => projectComposerMessageQueue([], [{
      id: 'local', text: 'unsent message', ts: 1, transientPlacement: placement,
      pendingSteering: placement === 'current_turn',
      deliveryActions: [{ label, disabled, onClick() { calls++; } }],
    }]);
    const view = await mountQueue({ queuedMessages: pending(true) });
    try {
      const button = actionButton(view.document, label);
      const item = button.closest('[role="listitem"]');
      assert.ok(item, 'a local message owns one semantic list item, including its feedback');
      assert.equal(item.querySelector('li')?.getAttribute('role'), 'presentation');
      assert.equal(item.querySelectorAll('[role="listitem"]').length, 0);
      assert.ok(button.closest('.maka-composer-queue-local-actions'), 'local actions wrap below the message instead of consuming its width');
      const actions = button.closest('.maka-composer-queue-local-actions');
      assert.equal(actions?.parentElement, item, 'actions use the full row outside the compact ListItem');
      assert.equal(actions?.previousElementSibling?.getAttribute('role'), 'status', 'recovery actions follow their status and guidance');
      assert.ok(button.disabled, 'unavailable actions use native button disabling');
      await click(button);
      assert.equal(calls, 0, 'disabled delivery actions cannot invoke recovery');
      await view.rerender({ queuedMessages: pending(false) });
      assert.equal(actionButton(view.document, label).disabled, false);
      await click(actionButton(view.document, label));
      assert.equal(calls, 1, 'recovery becomes usable when the pending operation settles');
    } finally {
      await view.close();
    }
  }
});

test('local delivery feedback stays visible in one stable polite status region', async () => {
  const { projectComposerMessageQueue } = await import('../composer-message-queue.js');
  const deliveryStatus = 'Message not sent';
  const details = [
    'Finish or clear the current draft, attachments and quotes before editing this message.',
    'Could not update the saved message. Try again.',
    'The message is ready in the composer. Review it before sending.',
  ];
  const message = { id: 'local', text: 'unsent message', ts: 1, transientPlacement: 'next_turn' as const };
  const view = await mountQueue({ queuedMessages: projectComposerMessageQueue([], [message]) });
  try {
    const statusSelector = '.maka-composer-queue-feedback[role="status"]';
    const status = view.document.querySelector(statusSelector);
    assert.ok(status, 'the live region exists before feedback is available');
    const item = status.closest('[role="listitem"]');
    assert.ok(item);
    assert.equal(status.parentElement, item, 'feedback gets a full-width row, outside the action-bearing ListItem');
    assert.equal(status.closest('li'), null, 'feedback does not compete with actions in the compact ListItem');
    assert.equal(item.querySelector('.maka-composer-queue-actions'), null, 'local rows without recovery actions do not show unavailable Host controls');
    assert.equal(status.textContent, '');
    for (const detail of details) {
      await view.rerender({ queuedMessages: projectComposerMessageQueue([], [{
        ...message, deliveryStatus, deliveryDetail: detail,
      }]) });
      assert.equal(view.document.querySelectorAll(statusSelector).length, 1);
      assert.equal(view.document.querySelector(statusSelector), status, 'updates reuse the live region');
      assert.equal(status.getAttribute('aria-live'), null, 'role=status already supplies polite announcements');
      assert.equal(status.getAttribute('title'), null, 'feedback is not hidden in a pointer-only title');
      assert.ok(status.textContent?.includes(deliveryStatus));
      assert.ok(status.textContent?.includes(detail));
      assert.ok(view.document.body.textContent?.includes(detail), 'recovery guidance is visible page text');
    }
  } finally {
    await view.close();
  }
});

test('Host-owned entries keep their ListItem semantics without a local feedback row', async () => {
  const view = await mountQueue({ queuedMessages: [queued('host', 'queued message')] });
  try {
    assert.equal(view.document.querySelectorAll('.maka-composer-queue-list li').length, 1);
    assert.equal(view.document.querySelector('.maka-composer-queue-list li')?.getAttribute('role'), null);
    assert.equal(view.document.querySelectorAll('.maka-composer-queue-list [role="listitem"]').length, 0);
    assert.equal(view.document.querySelector('.maka-composer-queue-feedback'), null);
  } finally {
    await view.close();
  }
});

test('local messages without delivery actions never inherit Host queue controls', async () => {
  const { projectComposerMessageQueue } = await import('../composer-message-queue.js');
  for (const deliveryActions of [undefined, []]) {
    const message = { id: 'local', text: 'saved follow-up', ts: 1, transientPlacement: 'next_turn' as const,
      deliveryStatus: 'Waiting to send', deliveryActions };
    const view = await mountQueue({ queuedMessages: projectComposerMessageQueue([], [message]) });
    try {
      const item = view.document.querySelector('.maka-composer-queue-list [role="listitem"]');
      assert.ok(item);
      assert.equal(item.querySelector('.maka-composer-queue-delivery')?.textContent, 'Waiting to send');
      assert.equal(item.querySelectorAll('button').length, 0, 'saved messages have no fake Host actions');
      await view.rerender({ queuedMessages: projectComposerMessageQueue([], [{
        ...message, deliveryActions: [{ label: 'Check delivery', onClick() {} }],
      }]) });
      assert.equal(item.querySelectorAll('button').length, 1);
      assert.equal(item.querySelector('button')?.textContent, 'Check delivery');
    } finally {
      await view.close();
    }
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
