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
import { fitAutocompleteLines } from '../tui-autocomplete-layout.js';
import { fitPendingQueueLines } from '../pi-tui-layout.js';

describe('fitAutocompleteLines', () => {
  test('keeps the selected item visible and reports the full command count', () => {
    const commands = Array.from(
      { length: 18 },
      (_, index) => `${index === 0 ? '→' : ' '} /command-${index + 1}`,
    );

    assert.deepEqual(fitAutocompleteLines(commands, 16), [...commands.slice(0, 15), '  (1/18)']);
  });

  test('moves the fitted window with a selection near the end', () => {
    const commands = Array.from(
      { length: 18 },
      (_, index) => `${index === 17 ? '→' : ' '} /command-${index + 1}`,
    );

    assert.deepEqual(fitAutocompleteLines(commands, 6), [...commands.slice(13), '  (18/18)']);
  });

  test('preserves an upstream picker position when fitting an already-windowed list', () => {
    const window = [
      '  /command-18',
      '  /command-19',
      '→ /command-20',
      '  /command-21',
      '  /command-22',
      '  (20/30)',
    ];

    assert.deepEqual(fitAutocompleteLines(window, 4), [
      '  /command-19',
      '→ /command-20',
      '  /command-21',
      '  (20/30)',
    ]);
  });

  test('uses the selected row when only one autocomplete row fits', () => {
    assert.deepEqual(fitAutocompleteLines(['  /one', '→ /two', '  /three'], 1), ['→ /two']);
  });
});

describe('fitPendingQueueLines', () => {
  test('summarizes overflow after preserving the visible pending rows', () => {
    const pending = Array.from({ length: 15 }, (_, index) => `Queued: message ${index + 1}`);

    assert.deepEqual(fitPendingQueueLines(pending, 3), [
      'Queued: message 1',
      'Queued: message 2',
      '… 13 more',
    ]);
  });

  test('uses the only available row as an overflow summary', () => {
    assert.deepEqual(fitPendingQueueLines(['Queued: one', 'Queued: two'], 1), ['… 2 more']);
  });
});
