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
  DEFAULT_LIMIT,
} from '../../../../plugins/application/clipboard-history/history.ts';
import {
  draftProblem,
  expandLink,
  parseLibrary,
} from '../../../../plugins/application/quick-library/library.ts';
import { symbols } from '../../../../plugins/application/symbols/symbols.ts';
import { afterKeyword, search } from '../../../../plugins/shared/quick-search.ts';
import { MAX_USAGE, parseUsage, ranked, recommended, recordUse } from '../app/quick-results.ts';
import {
  choose,
  entryMatch,
  normalAlias,
  parseChoices,
  recordable,
} from '../app/quick-commands.ts';

const names = (item) => [item];
const find = (items, query) =>
  ranked(
    search(items, query, [], names, true).map(({ item, match }) => ({ key: item, match, item })),
    {},
  ).map(({ item }) => item);

test('better matches come first', () => {
  const items = ['Screen Sharing', 'Bitmap', 'Road map', 'Map Editor', 'Maps'];
  assert.deepEqual(find(items, 'map'), ['Map Editor', 'Maps', 'Road map', 'Bitmap']);
  assert.deepEqual(find(items, 'zzz'), []);
});

test('one letter only matches the start of a word', () => {
  assert.deepEqual(find(['Bitmap', 'Road map'], 'm'), ['Road map']);
});

test('a keyword lists everything, and text after it searches only that tool', () => {
  const offered = (query) => search(['alpha', 'beta'], query, ['cb'], names).map((f) => f.item);
  assert.deepEqual(offered('cb'), ['alpha', 'beta']);
  assert.deepEqual(offered('cb be'), ['beta']);
  assert.deepEqual(offered('beta'), []);
});

test('among equal matches the most used comes first', () => {
  const at = 1_000_000;
  let usage = recordUse({}, 'b', at);
  usage = recordUse(usage, 'b', at + 1);
  usage = recordUse(usage, 'c', at + 2);
  const candidates = ['a', 'c', 'b'].map((key) => ({ key, match: 1 }));
  assert.deepEqual(
    ranked(candidates, usage).map(({ key }) => key),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    ranked(
      [
        { key: 'b', match: 2 },
        { key: 'a', match: 0 },
      ],
      usage,
    ).map(({ key }) => key),
    ['a', 'b'],
  );
});

test('only used, rememberable results are recommended', () => {
  const usage = recordUse({}, 'used', 1);
  const candidates = [
    { key: 'unused', remembered: true },
    { key: 'used', remembered: true },
  ];
  assert.deepEqual(
    recommended(candidates, usage).map(({ key }) => key),
    ['used'],
  );
  assert.deepEqual(recommended([{ key: 'used', remembered: false }], usage), []);
});

test('usage stays bounded by forgetting the least recent', () => {
  let usage = {};
  for (let at = 0; at <= MAX_USAGE; at += 1) usage = recordUse(usage, `key-${at}`, at);
  assert.equal(Object.keys(usage).length, MAX_USAGE);
  assert.equal(usage['key-0'], undefined);
  assert.deepEqual(parseUsage(JSON.stringify(usage)), usage);
  assert.deepEqual(parseUsage(null), {});
  assert.throws(() => parseUsage('[]'));
});

test('a keyword must stand alone, so ordinary questions are not captured', () => {
  assert.equal(afterKeyword('cb hello', ['cb']), 'hello');
  assert.equal(afterKeyword('CB', ['cb']), '');
  assert.equal(afterKeyword('cbs news', ['cb']), null);
  assert.equal(afterKeyword('文件 报告', ['f', '文件']), '报告');
});

test('symbols are found through their terms', () => {
  assert.deepEqual(
    search(symbols, 'sym rocket', ['sym'], ([, terms]) => [terms]).map(
      ({ item: [character] }) => character,
    ),
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

test('clipboard history preserves format, deduplicates file groups and respects its limit', () => {
  const entry = (change, format, data, paths = []) => ({ change, format, data, paths });
  const pdf = entry(1, 'com.adobe.pdf', 'YQ==');
  const image = entry(2, 'public.png', pdf.data);
  const files = entry(3, 'public.file-url', '', ['/tmp/one.pdf', '/tmp/two.png']);
  const again = { ...files, change: 5 };
  assert.deepEqual(remember([files, image, pdf], again, DEFAULT_LIMIT), [again, image, pdf]);
  let history = [];
  for (let i = 0; i < 55; i++)
    history = remember(history, entry(i, 'public.utf8-plain-text', String(i)), DEFAULT_LIMIT);
  assert.equal(history.length, DEFAULT_LIMIT);
  assert.equal(history[0].data, '54');
});

test('a command keeps its shortcut and alias until both are cleared', () => {
  let choices = choose({}, 'shot', { shortcut: 'cmd+shift+2' });
  choices = choose(choices, 'shot', { alias: 'ss' });
  assert.deepEqual(choices, { shot: { shortcut: 'cmd+shift+2', alias: 'ss' } });
  choices = choose(choices, 'shot', { shortcut: null });
  assert.deepEqual(choices, { shot: { alias: 'ss' } });
  assert.deepEqual(choose(choices, 'shot', { alias: '' }), {});
  assert.deepEqual(parseChoices(JSON.stringify(choices)), choices);
  assert.deepEqual(parseChoices(null), {});
  assert.throws(() => parseChoices('[]'));
  assert.throws(() => parseChoices('{"shot":{"alias":1}}'));
});

test('exact keywords and custom aliases outrank an exact result, while prefixes stay searches', () => {
  const keywords = ['note', 'notes', '笔记'];
  assert.equal(entryMatch('note', 'memo', keywords), -1);
  assert.equal(entryMatch('笔记', 'memo', keywords), -1);
  assert.equal(entryMatch(' MEMO ', 'memo', keywords), -2);
  assert.equal(entryMatch('not', 'memo', keywords), null);
  assert.equal(entryMatch('notebook', 'memo', keywords), null);
  assert.equal(normalAlias(' My Alias '), 'myalias');
});

test('a recorded shortcut needs a modifier that does not type text', () => {
  const keys = new Set(recordable(true));
  for (const taken of ['cmd+shift+s', 'ctrl+alt+space', 'alt+1', 'f5', 'cmd+ctrl+alt+shift+f12'])
    assert.ok(keys.has(taken), taken);
  for (const typed of ['s', 'shift+s', 'space', 'enter']) assert.ok(!keys.has(typed), typed);
  // The platform keeps these, and binding one throws.
  for (const kept of ['cmd+q', 'cmd+h', 'cmd+alt+h', 'cmd+m', 'cmd+ctrl+f'])
    assert.ok(!keys.has(kept), kept);
  assert.ok(!new Set(recordable(false)).has('alt+f4'));
  assert.ok(new Set(recordable(false)).has('cmd+q'));
});
