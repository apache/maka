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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computerUseModelCallArgs } from '../computer-use.js';

describe('the call as the model reads it back', () => {
  test('speaks the tool argument names', () => {
    assert.deepStrictEqual(
      computerUseModelCallArgs({
        action: 'click_element',
        app: 'Calculator',
        window_id: 42,
        observation_id: 'obs-1',
        element_id: 'e12',
      }),
      {
        action: 'click_element',
        app: 'Calculator',
        window_id: 42,
        observation_id: 'obs-1',
        element_id: 'e12',
      },
    );
  });

  test('a key name is a closed-set choice the model made, so it reads it back', () => {
    // `text` is six arguments under one name. For press_key, key and hold_key it
    // is a key name from the executor's set; withholding it left the model
    // reading "press_key ... text: <text>", unable to see which key it pressed.
    assert.deepStrictEqual(
      computerUseModelCallArgs({ action: 'press_key', observation_id: 'obs-1', text: 'Backspace' }),
      { action: 'press_key', observation_id: 'obs-1', text: 'Backspace' },
    );
    assert.strictEqual(
      computerUseModelCallArgs({ action: 'key', observation_id: 'obs-1', text: 'cmd+s' }).text,
      'cmd+s',
    );
    assert.deepStrictEqual(
      computerUseModelCallArgs({
        action: 'hold_key',
        observation_id: 'obs-1',
        text: 'shift',
        duration: 2,
      }),
      { action: 'hold_key', observation_id: 'obs-1', text: 'shift', duration: 2 },
    );
  });

  test('an element action name is a closed-set choice too', () => {
    assert.strictEqual(
      computerUseModelCallArgs({
        action: 'secondary_action',
        observation_id: 'obs-1',
        element_id: 'e12',
        text: 'raise',
      }).text,
      'raise',
    );
  });

  test('the same argument name stays withheld where it carries screen or typed text', () => {
    // select_text names a substring of what the window is showing, and type
    // carries whatever a person asked to be written. Same key, opposite origin.
    //
    // The placeholder carries the value's length and not the value. A bare
    // `<text>` was a fill-in-the-blank, and `text`/`value` are
    // `z.string().max(8000)` with no lower bound and no pattern — so it was a
    // legal call at the wire schema and at the strict union both, and a model
    // replaying its own set_value typed those six characters into the user's
    // field. `COMPUTER_USE_WITHHELD_VALUE` is what the tool refuses on.
    assert.strictEqual(
      computerUseModelCallArgs({
        action: 'select_text',
        observation_id: 'obs-1',
        element_id: 'e12',
        text: 'account balance 4,213.55',
      }).text,
      '<text:24>',
    );
    assert.strictEqual(
      computerUseModelCallArgs({ action: 'type', observation_id: 'obs-1', text: 'hunter2' }).text,
      '<text:7>',
    );
    assert.strictEqual(
      computerUseModelCallArgs({
        action: 'set_value',
        observation_id: 'obs-1',
        element_id: 'e12',
        value: 'hunter2',
      }).value,
      '<text:7>',
    );
  });

  test('an argument the model sent keeps its key even when its value is withheld', () => {
    // The failure this exists for: a projection that dropped unnamed arguments
    // showed set_value as a call with no value and scroll as one with no
    // direction, and the model sent that shape back.
    const scroll = computerUseModelCallArgs({
      action: 'scroll',
      observation_id: 'obs-1',
      coordinate: [10, 20],
      scroll_direction: 'down',
      scroll_amount: 3,
    });
    assert.deepStrictEqual(scroll, {
      action: 'scroll',
      observation_id: 'obs-1',
      coordinate: [10, 20],
      scroll_direction: 'down',
      scroll_amount: 3,
    });
  });

  test("a coordinate is the model's own output, so it reads it back", () => {
    // Not screen-derived: four digits the model chose and sent. Reduced to
    // `<point>`, a model that clicked and missed cannot tell whether it has
    // already tried that point, which is the repeated-call shape this
    // projection exists to make visible.
    assert.deepStrictEqual(
      computerUseModelCallArgs({
        action: 'left_click',
        observation_id: 'obs-1',
        coordinate: [412, 88],
      }),
      { action: 'left_click', observation_id: 'obs-1', coordinate: [412, 88] },
    );
    assert.deepStrictEqual(
      computerUseModelCallArgs({
        action: 'left_click_drag',
        observation_id: 'obs-1',
        start_coordinate: [10, 20],
        coordinate: [412, 88],
      }),
      {
        action: 'left_click_drag',
        observation_id: 'obs-1',
        start_coordinate: [10, 20],
        coordinate: [412, 88],
      },
    );
    assert.deepStrictEqual(
      computerUseModelCallArgs({ action: 'zoom', observation_id: 'obs-1', region: [1, 2, 3, 4] })
        .region,
      [1, 2, 3, 4],
    );
  });

  test('a geometry argument that is not integers still degrades to a shape', () => {
    assert.strictEqual(
      computerUseModelCallArgs({
        action: 'left_click',
        observation_id: 'obs-1',
        coordinate: ['412', '88'],
      }).coordinate,
      '<2 items>',
    );
    assert.strictEqual(
      computerUseModelCallArgs({ action: 'left_click', observation_id: 'obs-1', coordinate: 'x' })
        .coordinate,
      '<text:1>',
    );
  });

  test('an action the tool cannot accept is reported as the model sent it', () => {
    // Erasing the action would remove the one thing this record is for — a model whose call was
    // rejected for naming an action the schema does not carry could not connect
    // the rejection to what it had sent.
    //
    // Written with `element_sequence`, which was the real example of a name the
    // schema did not carry until the branch that adds the executor carried it.
    // A test for an unknown action has to name one that stays unknown, or it
    // asserts the catalog's contents by accident and fails the day it grows.
    const projected = computerUseModelCallArgs({
      action: 'summon_the_window',
      observation_id: 'obs-1',
      text: 'account balance 4,213.55',
    });
    assert.strictEqual(projected.action, 'summon_the_window');
    // It is not a known action, so nothing about it is treated as plain.
    assert.strictEqual(projected.text, '<text:24>');
  });

  test('a non-string action is the only thing left that reads as unknown', () => {
    assert.strictEqual(computerUseModelCallArgs({ action: 7 }).action, 'unknown');
    assert.strictEqual(computerUseModelCallArgs({}).action, 'unknown');
  });
});
