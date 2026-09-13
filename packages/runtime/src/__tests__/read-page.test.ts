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
import { readPage, readToolResultPage, READ_PAGE_MAX_CHARS, type ReadInput } from '../read-page.js';

test('default and explicit large ranges stay bounded and continue to the requested end', () => {
  const lines = Array.from({ length: 900 }, (_, i) => `line ${i} ${'x'.repeat(160)}`);
  for (const limit of [undefined, 80, 1_000_000]) {
    let input: ReadInput | null = { path: 'file.txt', offset: 200, ...(limit ? { limit } : {}) };
    const returned: string[] = [];
    while (input) {
      const page = readPage(lines.join('\n'), input);
      assert.ok(JSON.stringify(page).length <= READ_PAGE_MAX_CHARS);
      assert.ok(page.returnedLines > 0);
      returned.push(...page.content.split('\n'));
      assert.notDeepEqual(page.next, input);
      input = page.next;
      assert.ok(returned.length <= 700);
    }
    assert.deepEqual(returned, lines.slice(200, limit ? 200 + limit : undefined));
  }
});

test('a long Unicode line continues without loss and refuses changed content', () => {
  const content = 'first\n' + '😀\\"'.repeat(12_000) + '\nlast';
  const pieces: string[] = [];
  let input: ReadInput | null = { path: 'long.txt', offset: 1, limit: 1 };
  while (input) {
    const page = readPage(content, input);
    assert.ok(JSON.stringify(page).length <= READ_PAGE_MAX_CHARS);
    assert.ok(page.content.length > 0);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.content));
    pieces.push(page.content);
    if (page.next)
      assert.throws(() => readPage(content + 'changed', page.next!), /content changed/);
    input = page.next;
    assert.ok(pieces.length < 100);
  }
  assert.equal(pieces.join(''), content.split('\n')[1]);
});

test('archive Read decodes content lines and retains terminal execution metadata', () => {
  assert.equal(
    readToolResultPage(JSON.stringify({ content: 'a\nb\nc' }), {
      path: 'maka://runtime/tool-results/e',
      offset: 1,
      limit: 1,
    }).content,
    'b',
  );
  const page = readToolResultPage(
    JSON.stringify({
      kind: 'terminal',
      exitCode: 2,
      output: { stdout: 'one\ntwo', stderr: 'error' },
    }),
    { path: 'maka://runtime/tool-results/e' },
  );
  assert.equal(page.content, 'one\ntwo\nerror');
  assert.equal(page.metadata?.exitCode, 2);
  assert.equal(page.next, null);
  assert.deepEqual(readPage('', { path: 'empty', offset: 3 }), {
    content: '',
    offset: 3,
    returnedLines: 0,
    totalLines: 1,
    next: null,
  });
});
