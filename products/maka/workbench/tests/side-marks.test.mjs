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
import test from 'node:test';
import { markPassages } from '../app/sideMarks.ts';

const mark = (quotes, open = true) => [{ id: 's1', title: 'Why?', quotes, open }];

test('a quoted passage becomes a link to its side question', () => {
  const { markdown, found } = markPassages('The cache is **warm** now.', mark(['cache is warm']));
  assert.deepEqual([...found], ['s1']);
  assert.equal(
    markdown,
    'The [cache is ](maka-side:s1 "Why?")**[warm](maka-side:s1 "Why?")** now.',
  );
});

test('code is never marked, also in a fence under a list item or in a quote', () => {
  for (const reply of [
    '```\nlet total = 1;\n```',
    '1. Step\n\n    ```js\n    let total = 1;\n    ```',
    '- ```js\n  let total = 1;\n  ```',
    '> ```\n> let total = 1;\n> ```',
    'Use `let total = 1;` here.',
  ]) {
    const { markdown, found } = markPassages(reply, mark(['let total = 1;']));
    assert.equal(markdown, reply);
    assert.equal(found.size, 0);
  }
});
