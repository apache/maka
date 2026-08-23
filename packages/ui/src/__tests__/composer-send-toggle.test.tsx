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
import { renderToStaticMarkup } from 'react-dom/server';
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

test('renders the pending plate with per-entry promote, retract, and reorder', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        streaming
        queuedMessages={[{
          entryId: 'entry-1',
          messageId: 'message-1',
          content: { text: 'do this next' },
          placement: 'next_turn',
          state: 'queued',
        }]}
        onPromoteQueuedEntry={() => undefined}
        onRetractQueuedEntry={() => undefined}
        onReorderQueuedEntries={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );

  assert.match(markup, /1 queued message/);
  assert.match(markup, /do this next/);
  assert.match(markup, /aria-label="Send now"/);
  assert.match(markup, /aria-label="Restore to draft"/g);
  assert.match(markup, /aria-label="Drag to reorder"/);
});
