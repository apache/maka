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

import {
  COMPUTER_USE_REFINEMENT_MESSAGES,
  computerActionFields,
  computerParams,
  describeComputerUseArgsViolation,
} from '../computer-use-codec.js';

/** The error the tool runtime actually holds when arguments fail validation. */
function refusalFor(args: unknown): unknown {
  const parsed = computerParams.safeParse(args);
  assert.equal(parsed.success, false, 'these arguments were supposed to be refused');
  return parsed.error;
}

describe('computer use argument refusals', () => {
  test('tells a call in the wrong dialect what this action does take', () => {
    // Every target key is in camelCase. Naming only what is wrong left the
    // model re-sending the same shape.
    const args = {
      action: 'click_element',
      app: 'com.apple.calculator',
      windowId: 8677,
      observationId: 'obs-1',
    };

    const said = describeComputerUseArgsViolation(refusalFor(args), args);

    assert.ok(said);
    assert.match(said, /does not take/);
    assert.match(said, /This action takes/);
    for (const field of computerActionFields('click_element') ?? []) {
      assert.ok(said.includes(`\`${field}\``), `the correction should name \`${field}\``);
    }
  });

  test('names no fields for an action it does not know', () => {
    const args = { action: 'teleport', app: 'com.apple.calculator' };

    const said = describeComputerUseArgsViolation(refusalFor(args), args);

    assert.ok(said);
    assert.doesNotMatch(said, /This action takes/);
  });

  test('keeps values out of what it says', () => {
    // Arguments can carry typed text, so a refusal may name fields and never
    // their contents.
    const secret = 'hunter2-correct-horse';
    const args = { action: 'type_text', text: secret, windowId: 1 };

    const said = describeComputerUseArgsViolation(refusalFor(args), args);

    assert.ok(said);
    assert.ok(!said.includes(secret), 'a refusal must not echo a typed value');
  });

  test('reads the field list off the schema itself', () => {
    assert.deepEqual(computerActionFields('list_apps'), ['app']);
    assert.equal(computerActionFields('teleport'), undefined);
    assert.equal(computerActionFields(undefined), undefined);
  });

  test('carries a refinement sentence through instead of the generic complaint', () => {
    // A `.refine()` failure has an empty `issue.path`, so every field-name
    // branch misses it and the fallback used to answer "the argument shape does
    // not match this action" — replacing the one sentence that said which of
    // two arguments to add.
    const args = { action: 'observe' };

    const said = describeComputerUseArgsViolation(refusalFor(args), args);

    assert.ok(said);
    assert.match(said, /requires app or window_id/);
    assert.doesNotMatch(said, /the argument shape does not match/);
  });

  test('says nothing about approval, which is not a thing the model can send', () => {
    for (const action of ['observe', 'screenshot']) {
      const args = { action };
      const said = describeComputerUseArgsViolation(refusalFor(args), args);
      assert.ok(said);
      assert.doesNotMatch(said, /approval/i, `${action} leaked the approval pipeline`);
    }
    assert.doesNotMatch(
      JSON.stringify(COMPUTER_USE_REFINEMENT_MESSAGES),
      /approval/i,
      'no schema refinement may mention approval',
    );
  });

  test('passes through only the sentences this schema wrote', () => {
    // `message` is free prose. One arriving from anywhere else could be quoting
    // the arguments — which can hold a typed password — straight back.
    const secret = 'hunter2-correct-horse';
    const forged = { issues: [{ code: 'custom', path: [], message: `value was ${secret}` }] };

    const said = describeComputerUseArgsViolation(forged, { action: 'observe' });

    assert.ok(said);
    assert.ok(!said.includes(secret), 'a foreign message must not reach the model verbatim');
  });
});
