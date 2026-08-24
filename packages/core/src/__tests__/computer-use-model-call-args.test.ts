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
import { COMPUTER_USE_WITHHELD_VALUE, computerUseModelCallArgs } from '../computer-use.js';

describe('the call a model reads back as its own', () => {
  test('keeps the arguments it sent, so the shape it learns is the shape that worked', () => {
    // This projection named five keys and dropped everything else, which meant
    // `element_sequence` came back as a call carrying only an observation id.
    // A model reading that learns the empty shape is the one that succeeded,
    // and sends it again — a real session refused eighteen calls for missing
    // exactly the fields this had removed.
    const readBack = computerUseModelCallArgs({
      action: 'element_sequence',
      observation_id: 'obs-1',
      app: 'com.apple.calculator',
      steps: [{ label: '7' }, { label: '×' }, { label: '8' }],
    });

    assert.equal(readBack.action, 'element_sequence');
    assert.equal(readBack.observation_id, 'obs-1');
    assert.ok('steps' in readBack, 'the call had steps and its record must say so');
  });

  test('says how much a value held without saying what it was', () => {
    const readBack = computerUseModelCallArgs({
      action: 'set_value',
      observation_id: 'obs-1',
      element_id: '4',
      value: 'the-users-password',
    });

    assert.ok('value' in readBack);
    assert.ok(
      !JSON.stringify(readBack).includes('the-users-password'),
      'a typed value is screen content and never belongs in the record',
    );
  });

  test('a coordinate the model chose comes back whole, and a broken one degrades', () => {
    // Written when this projection reduced every coordinate to `<point>`, and
    // that was the wrong half of the rule: a coordinate is not read off the
    // screen, it is four digits the model chose and sent. Reduced to a shape, a
    // model that clicked and missed cannot tell whether it has already tried
    // that point — the repeated-call shape this record exists to make visible.
    const readBack = computerUseModelCallArgs({
      action: 'left_click',
      observation_id: 'obs-1',
      coordinate: [812, 466],
    });

    assert.deepEqual(readBack.coordinate, [812, 466]);
    // Only integers. Anything else is not a coordinate and is not echoed as one.
    assert.equal(
      computerUseModelCallArgs({
        action: 'left_click',
        observation_id: 'obs-1',
        coordinate: ['812', '466'],
      }).coordinate,
      '<2 items>',
    );
  });

  test('a window move reads back the place it asked for, and the verb it used', () => {
    // Both were shapes: `window_action: "<text:4>"` against a
    // `z.enum(['move','resize','minimize'])` and `position: "<point>"` against
    // a tuple. The wire schema is `.strict()`, so a model replaying its own
    // window move was rejected by the SDK before `impl` ran, and the rejection
    // never reached the debug journal that wraps `impl`.
    const readBack = computerUseModelCallArgs({
      action: 'window_action',
      observation_id: 'obs-1',
      element_id: '0',
      window_action: 'move',
      position: [-193, -1080],
    });

    assert.equal(readBack.window_action, 'move');
    assert.deepEqual(readBack.position, [-193, -1080]);
  });

  test('a scrolled element reads back which way and how far', () => {
    const readBack = computerUseModelCallArgs({
      action: 'scroll_element',
      observation_id: 'obs-1',
      element_id: '9',
      scroll_direction: 'down',
      scroll_amount: 3,
    });

    assert.equal(readBack.scroll_direction, 'down');
    assert.equal(readBack.scroll_amount, 3);
  });

  test('a wait reads back what it was waiting for', () => {
    // `wait_for_text` is a prediction about the screen, written before the
    // screen shows it — the model's own words, not a value read off a window.
    const readBack = computerUseModelCallArgs({
      action: 'wait',
      observation_id: 'obs-1',
      duration: 5,
      wait_for_text: 'Exporting',
    });

    assert.equal(readBack.wait_for_text, 'Exporting');
    assert.equal(readBack.duration, 5);
  });

  test('a sequence stays a list of steps, with each label withheld', () => {
    // `steps` reduced to `"<2 items>"` is a string where the schema wants an
    // array, so a replayed sequence died off the wire and was never journalled.
    // Projected member by member it stays an array: the call is refused by name
    // for holding a placeholder, which the model can read and act on.
    const readBack = computerUseModelCallArgs({
      action: 'element_sequence',
      observation_id: 'obs-1',
      steps: [
        { label: '7' },
        { label: '账户余额', role: 'AXTextField', do: 'set_value', value: '4213.55' },
      ],
    });

    assert.deepEqual(readBack.steps, [
      { label: '<text:1>' },
      { label: '<text:4>', role: 'AXTextField', do: 'set_value', value: '<text:7>' },
    ]);
    assert.ok(!JSON.stringify(readBack).includes('4213.55'));
    assert.ok(!JSON.stringify(readBack).includes('账户余额'));
  });

  test('keeps a value the model chose itself', () => {
    // These are the model's own words or its pick from a fixed set. Reducing
    // them to a shape would cost it the ability to see what it searched for
    // or which way it scrolled, and none of them come off the screen.
    const readBack = computerUseModelCallArgs({
      action: 'observe',
      app: 'com.apple.finder',
      query: '下载',
      include_screenshot: false,
    });

    assert.equal(readBack.query, '下载');
    assert.equal(readBack.include_screenshot, false);
    assert.equal(
      computerUseModelCallArgs({ action: 'observe', app: 'com.apple.TextEdit', menu: '文件' }).menu,
      '文件',
    );
  });

  test('never shows a host-only field as though the model had sent it', () => {
    const readBack = computerUseModelCallArgs({
      action: 'click_element',
      observation_id: 'obs-1',
      element_id: '4',
      approvalClass: 'semantic_mutation',
      rememberForTurnAllowed: false,
    });

    assert.ok(!('approvalClass' in readBack));
    assert.ok(!('rememberForTurnAllowed' in readBack));
  });

  test('never shows the element identity the host resolved for itself', () => {
    // The Computer Use tool attaches the observed element's identity so the
    // host can verify the target. It is not in the wire schema, and that schema
    // is `.strict()`: a model imitating this record sends `element_identity`,
    // the SDK refuses the whole call before `impl`, and the refusal never
    // reaches the debug journal.
    const readBack = computerUseModelCallArgs({
      action: 'click_element',
      observation_id: 'obs-1',
      element_id: '4',
      element_identity: { token: 'ax-token', role: 'AXButton', label: 'Continue' },
    });

    assert.ok(!('element_identity' in readBack));
    assert.ok(!JSON.stringify(readBack).includes('ax-token'));
  });

  test('a withheld value is a description of one, not a string that can be resent', () => {
    // `value` and `text` are `z.string().max(8000)` with no lower bound and no
    // pattern, so whatever stands in for a withheld value is a legal call. It
    // was `<text>` — a fill-in-the-blank — and a model replaying its own
    // set_value would have typed those six characters into the user's field.
    const readBack = computerUseModelCallArgs({
      action: 'set_value',
      observation_id: 'obs-1',
      element_id: '4',
      value: 'the-users-password',
    });

    assert.equal(readBack.value, '<text:18>');
    assert.match(String(readBack.value), COMPUTER_USE_WITHHELD_VALUE);
  });

  test('answers a camelCase key in the dialect the tool accepts', () => {
    const readBack = computerUseModelCallArgs({
      action: 'click_element',
      windowId: 8677,
      observationId: 'obs-1',
      elementId: '4',
    });

    assert.equal(readBack.window_id, 8677);
    assert.equal(readBack.observation_id, 'obs-1');
    assert.equal(readBack.element_id, '4');
    assert.ok(!('windowId' in readBack));
  });
});
