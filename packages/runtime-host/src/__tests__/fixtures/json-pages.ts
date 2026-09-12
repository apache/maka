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

/** Independently checks page selection using complete JSON, not the budget helper. */
export function assertMaximalJsonPages<Page extends object, Item>(
  pages: readonly Page[],
  expectedItems: readonly Item[],
  options: {
    maxBytes: number;
    maxItems: number;
    items: (page: Page) => readonly Item[];
    candidate: (page: Page, items: readonly Item[], end: number) => object;
  },
): void {
  let offset = 0;
  for (const page of pages) {
    const limit = Math.min(expectedItems.length, offset + options.maxItems);
    let end = offset;
    while (end < limit) {
      const candidate = options.candidate(page, expectedItems.slice(offset, end + 1), end + 1);
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > options.maxBytes) break;
      end += 1;
    }
    assert.ok(end > offset, 'each page must make progress');
    assert.deepEqual(options.items(page), expectedItems.slice(offset, end));
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= options.maxBytes);
    offset = end;
  }
  assert.equal(offset, expectedItems.length, 'continuations must return every item exactly once');
}
