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
 * The composer's send slot holds ONE control (Astryx's send/stop toggle), and
 * mid-turn it reads Stop while the draft is empty. This is the shape the slot
 * drifted out of more than once — a Stop button and a Steer button side by
 * side, then a Queue/Steer mode switch beside Send — so the count is asserted,
 * not just the label. Queue affordances live in the pending plate above the
 * card, never in the send slot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

function renderComposer(streaming: boolean): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer streaming={streaming} onSend={() => undefined} onStop={() => undefined} />
    </LocaleProvider>,
  );
}

function sendSlotControls(markup: string): string[] {
  return markup.match(/aria-label="(?:Send|Stop)"/g) ?? [];
}

test('an idle composer offers Send alone', () => {
  const controls = sendSlotControls(renderComposer(false));
  assert.deepEqual(controls, ['aria-label="Send"']);
});

test('a turn in flight turns the same single control into Stop', () => {
  const controls = sendSlotControls(renderComposer(true));
  assert.deepEqual(controls, ['aria-label="Stop"']);
});

test('a running composer keeps Send alone — no mode switch in the send slot', () => {
  const markup = renderComposer(true);
  assert.deepEqual(sendSlotControls(markup), ['aria-label="Stop"']);
  assert.doesNotMatch(markup, /Follow-up behavior/);
  assert.doesNotMatch(markup, /SegmentedControl/);
});

test('keeps Host order visible until the reordered projection arrives', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  let requestedOrder: readonly string[] | undefined;
  const updatedEntries: Array<{
    entryId: string;
    expectedQueueRevision: number;
    text: string;
  }> = [];
  const deletedEntryIds: string[] = [];

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          streaming
          queuedMessages={[
            {
              entryId: 'steering',
              messageId: 'message-steering',
              content: { text: 'steering' },
              placement: 'current_turn',
              state: 'queued',
            },
            ...['first', 'second'].map((entryId) => ({
              entryId,
              messageId: `message-${entryId}`,
              content: { text: entryId },
              placement: 'next_turn' as const,
              state: 'queued' as const,
            })),
          ]}
          queuedMessageRevision={7}
          onPromoteQueuedEntry={() => undefined}
          onUpdateQueuedEntry={(entryId, expectedQueueRevision, text) => {
            updatedEntries.push({ entryId, expectedQueueRevision, text });
          }}
          onDeleteQueuedEntry={(entryId) => {
            deletedEntryIds.push(entryId);
          }}
          onReorderQueuedEntries={(entryIds) => {
            requestedOrder = entryIds;
            return new Promise<void>(() => undefined);
          }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    const editButtons = buttons.filter((button) => button.textContent === 'Edit');
    const deleteButtons = [
      ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Delete"]'),
    ];
    assert.equal(buttons.filter((button) => button.textContent === 'Steer').length, 2);
    assert.equal(editButtons.length, 3);
    assert.equal(deleteButtons.length, 3);
    await act(async () => {
      editButtons[0]?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });
    const editInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit"]',
    );
    assert.ok(editInput);
    await act(() => {
      editInput.value = 'updated steering\nsecond line';
      editInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Save"]')
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Delete"]')
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(updatedEntries, [{
      entryId: 'steering',
      expectedQueueRevision: 7,
      text: 'updated steering\nsecond line',
    }]);
    assert.deepEqual(deletedEntryIds, ['steering']);
    const grips = [...container.querySelectorAll<HTMLElement>('.maka-composer-queue-grip')];
    assert.equal(grips.length, 2);
    const dragStart = new window.Event('dragstart', { bubbles: true });
    Object.defineProperty(dragStart, 'dataTransfer', {
      value: { effectAllowed: '', setData() {} },
    });
    await act(() => grips[1]?.dispatchEvent(dragStart));
    const rows = [...container.querySelectorAll('li')];
    const steeringRow = rows[0]?.parentElement;
    assert.ok(steeringRow);
    await act(() => steeringRow.dispatchEvent(new window.Event('drop', { bubbles: true })));
    assert.equal(requestedOrder, undefined);
    const firstRow = grips[0]?.closest('li')?.parentElement;
    assert.ok(firstRow);
    await act(() => firstRow.dispatchEvent(new window.Event('drop', { bubbles: true })));

    assert.deepEqual(requestedOrder, ['second', 'first']);
    assert.deepEqual(
      rows.map((row) => {
        if (row.textContent?.includes('steering')) return 'steering';
        return row.textContent?.includes('first') ? 'first' : 'second';
      }),
      ['steering', 'first', 'second'],
    );
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
