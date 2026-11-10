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
import {
  remember,
  MAX_ENTRIES,
} from '../../../../plugins/application/clipboard-history/history.ts';
import {
  draftProblem,
  expandLink,
  parseLibrary,
} from '../../../../plugins/application/quick-library/library.ts';
import { symbols } from '../../../../plugins/application/symbols/symbols.ts';
import { afterKeyword, rank } from '../../../../plugins/shared/quick-search.ts';

const names = (item) => [item];

test('better matches come first and a limit applies after ranking', () => {
  const items = ['Screen Sharing', 'Maps', 'Map Editor', 'Bitmap', 'Road map'];
  assert.deepEqual(rank(items, 'map', names, 10), ['Maps', 'Map Editor', 'Road map', 'Bitmap']);
  assert.deepEqual(rank(items, 'ma', names, 1), ['Maps']);
  assert.deepEqual(rank(items, '   ', names, 10), []);
});

test('one letter only matches the start of a word', () => {
  assert.deepEqual(rank(['Bitmap', 'Road map'], 'm', names, 10), ['Road map']);
});

test('a keyword must stand alone, so ordinary questions are not captured', () => {
  assert.equal(afterKeyword('cb hello', ['cb']), 'hello');
  assert.equal(afterKeyword('CB', ['cb']), '');
  assert.equal(afterKeyword('cbs news', ['cb']), null);
  assert.equal(afterKeyword('文件 报告', ['f', '文件']), '报告');
});

test('symbols are found through their terms', () => {
  assert.deepEqual(
    rank(symbols, 'rocket', ([, terms]) => [terms], 5).map(([character]) => character),
    ['🚀'],
  );
});

test('a template link receives the typed text encoded', () => {
  assert.equal(
    expandLink('https://example.com/search?q={query}', 'a&b c'),
    'https://example.com/search?q=a%26b%20c',
  );
});

test('a library entry is validated before it is saved', () => {
  const draft = { id: null, kind: 'snippet', name: 'Sign-off', value: 'Regards' };
  assert.equal(draftProblem(draft), null);
  assert.equal(draftProblem({ ...draft, name: '  ' }), 'Enter a name');
  assert.equal(draftProblem({ ...draft, value: ' ' }), 'Enter some content');
  const link = { ...draft, kind: 'link' };
  assert.equal(
    draftProblem({ ...link, value: 'javascript:alert(1)' }),
    'Enter a URL starting with http:// or https://',
  );
  assert.equal(draftProblem({ ...link, value: 'https://example.com/{query}' }), null);
});

test('damaged library data is an error rather than an empty library', () => {
  assert.deepEqual(parseLibrary(null), []);
  assert.throws(() => parseLibrary('{}'));
  assert.throws(() => parseLibrary('not json'));
});

test('clipboard history keeps the newest copy of each text and stays bounded', () => {
  assert.deepEqual(remember(['b', 'a'], 'a'), ['a', 'b']);
  let history = [];
  for (let index = 0; index < MAX_ENTRIES + 5; index += 1) history = remember(history, `${index}`);
  assert.equal(history.length, MAX_ENTRIES);
  assert.equal(history[0], `${MAX_ENTRIES + 4}`);
});
