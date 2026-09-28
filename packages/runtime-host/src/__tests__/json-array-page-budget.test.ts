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
import { test } from 'node:test';
import { JsonArrayPageBudget } from '../server/json-array-page-budget.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

for (const cursorKey of ['nextCursor', 'nextOffset']) {
  test(`incremental ${cursorKey} budgets match whole-page JSON at exact boundaries`, () => {
    const items = [
      { text: '中文🙂 \"quoted\" \\path\n', optional: undefined },
      { values: [null, true, 3.5], nested: { text: '\ud800' } },
      undefined,
    ];
    const cursors = [null, 9, 10, 99, 100, '目录\"\\🙂', { part: 'model', index: 100 }];
    const empty = { kind: 'page', revision: '版本', items: [], [cursorKey]: null };
    for (const cursor of cursors) {
      for (const count of [1, 2, 3]) {
        const limit = bytes({ ...empty, items: items.slice(0, count), [cursorKey]: cursor });
        for (const delta of [-1, 0, 1]) {
          const budget = new JsonArrayPageBudget(limit + delta, empty);
          const accepted: unknown[] = [];
          for (const item of items) {
            const fits =
              bytes({ ...empty, items: [...accepted, item], [cursorKey]: cursor }) <= limit + delta;
            assert.equal(budget.tryAppend(item, cursor), fits);
            if (fits) accepted.push(item);
          }
        }
      }
    }
  });
}

test('a rejected candidate does not consume item bytes or a comma', () => {
  const empty = { items: [], nextCursor: null };
  const budget = new JsonArrayPageBudget(bytes({ items: ['a', 'b'], nextCursor: null }), empty);
  assert.equal(budget.tryAppend('too large'.repeat(20), 99), false);
  assert.equal(budget.tryAppend('a', 9), true);
  assert.equal(budget.tryAppend('too large'.repeat(20), 100), false);
  assert.equal(budget.tryAppend('b', null), true);
  assert.equal(budget.tryAppend('c', null), false);
});

test('cursor growth and final null are charged to the candidate being tested', () => {
  const empty = { items: [], nextCursor: null };
  for (const cursor of [9, 10, 99, 100, null]) {
    const budget = new JsonArrayPageBudget(bytes({ items: ['a', 'b'], nextCursor: cursor }), empty);
    assert.equal(budget.tryAppend('a', 9), true);
    assert.equal(budget.tryAppend('b', cursor), true);
  }
});
