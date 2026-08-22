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

// What the wire adapter says when it cannot build an action.
//
// These throws become the tool result the model reads, so the code in front of
// the colon is the first thing it acts on. Two of them named a coordinate for
// failures that had nothing to do with one, which sends a model that mistyped
// an action name or forgot `text` off to check its coordinates.
import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptToCuAction, computerActionNames } from '../computer-use-codec.js';

test('a missing text is reported as a missing argument, not a bad coordinate', () => {
  for (const action of ['type', 'key', 'hold_key'] as const) {
    assert.throws(
      () => adaptToCuAction({ action, observation_id: 'obs-1' } as never),
      (error: Error) => {
        assert.doesNotMatch(error.message, /invalid_coordinate/);
        assert.match(error.message, /requires text/);
        assert.match(error.message, /`text`/);
        return true;
      },
      `${action} should name the argument it is missing`,
    );
  }
});

test('an unknown action is answered with the actions this tool takes', () => {
  assert.throws(
    () => adaptToCuAction({ action: 'type_text', text: 'hello' } as never),
    (error: Error) => {
      assert.doesNotMatch(error.message, /invalid_coordinate/);
      // The word it sent back is not the answer; the closed set is.
      for (const name of ['type', 'key', 'left_click', 'observe', 'click_element']) {
        assert.ok(error.message.includes(name), `the refusal should list \`${name}\``);
      }
      return true;
    },
  );
});

test('an unknown action never echoes what was sent with it', () => {
  const secret = 'hunter2-correct-horse';
  assert.throws(
    () => adaptToCuAction({ action: 'type_text', text: secret } as never),
    (error: Error) => {
      assert.ok(!error.message.includes(secret), 'a refusal must not echo a typed value');
      return true;
    },
  );
});

test('the action list is read off the schema rather than kept by hand', () => {
  const names = computerActionNames();
  assert.ok(names.includes('element_sequence'));
  assert.ok(names.includes('window_action'));
  assert.equal(new Set(names).size, names.length, 'no action should be listed twice');
});

test('a coordinate action that is missing its coordinate still says so', () => {
  assert.throws(
    () => adaptToCuAction({ action: 'left_click', observation_id: 'obs-1' } as never),
    /invalid_coordinate/,
  );
});
