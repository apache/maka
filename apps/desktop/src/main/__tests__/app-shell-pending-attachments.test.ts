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
import { appendPending, clearPending, removePending, removePendingItems, selectPending } from '../../renderer/app-shell-pending-attachments.js';

describe('pending attachments by draft key', () => {
  test('selecting another key never leaks pending from a different session', () => {
    const map = appendPending<string>({}, 'session-a', ['a1']);
    assert.deepEqual(selectPending(map, 'session-a'), ['a1']);
    assert.deepEqual(selectPending(map, 'session-b'), []);
  });

  test('removes a single pending by index without touching other keys', () => {
    let map = appendPending<string>({}, 'a', ['a1', 'a2']);
    map = appendPending(map, 'b', ['b1']);
    const next = removePending(map, 'a', 0);
    assert.deepEqual(selectPending(next, 'a'), ['a2']);
    assert.deepEqual(selectPending(next, 'b'), ['b1']);
  });

  test('clears one key without affecting others', () => {
    let map = appendPending<string>({}, 'a', ['a1']);
    map = appendPending(map, 'b', ['b1']);
    const next = clearPending(map, 'a');
    assert.deepEqual(selectPending(next, 'a'), []);
    assert.deepEqual(selectPending(next, 'b'), ['b1']);
  });

  test('successful send removes only its submitted snapshot', () => {
    const submitted = { name: 'submitted' };
    const addedWhileSending = { name: 'added later' };
    let map = appendPending({}, 'draft', [submitted]);
    map = appendPending(map, 'draft', [addedWhileSending]);

    const next = removePendingItems(map, 'draft', [submitted]);

    assert.deepEqual(selectPending(next, 'draft'), [addedWhileSending]);
  });

  test('removes by caller identity even when the submitted snapshot was re-derived', () => {
    // The composer hands back merged copies (e.g. with a late-arriving
    // previewUrl), so reference equality would strand the staged originals.
    const staged = { id: 'a', name: 'shot.png' };
    const kept = { id: 'b', name: 'notes.md' };
    const map = appendPending({}, 'draft', [staged, kept]);

    const submittedCopy = { ...staged, previewUrl: 'data:image/png;base64,xyz' };
    const next = removePendingItems(map, 'draft', [submittedCopy], (item) => item.id);

    assert.deepEqual(selectPending(next, 'draft'), [kept]);
  });
});
