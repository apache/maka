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
import {
  COMPUTER_HISTORY_SEARCH_EXCERPT_MAX_CHARS,
  computerHistorySearchExcerpt,
  computerHistorySearchNormalize,
  computerHistorySearchTerms,
  historyApplicationBlocked,
  historyApplicationId,
} from '../computer-history.js';

test('application identities remain exact across platforms and reject malformed explicit sources', () => {
  const aumid = `${'Package'.padEnd(50, 'x')}_8wekyb3d8bbwe!${'App'.padEnd(64, 'a')}`;
  const app = { bundleIdentifier: 'win32.sharedhost', applicationUserModelId: aumid };
  assert.equal(historyApplicationId(app), `winapp.${aumid}`);
  for (const id of [
    `winapp.${aumid}`,
    'win32._fixture_app',
    'com.apple.Safari',
    'com.' + 'a'.repeat(252),
  ]) {
    assert.equal(historyApplicationId({ bundleIdentifier: id }), id);
  }
  for (const id of [
    null,
    '',
    'Safari',
    'Winapp.Package_8wekyb3d8bbwe!App',
    'winapp.invalid',
    `winapp.${aumid}x`,
    'Win32.editor',
    'win32.editor.exe',
    'win32.editor..tail',
    'com.example.<x>',
    'com.example/path',
    'com.example.\u4e2d\u6587',
    'com.example.App\n',
    'com.' + 'a'.repeat(253),
  ]) {
    assert.equal(historyApplicationId({ bundleIdentifier: id }), null);
    assert.equal(historyApplicationBlocked({ bundleIdentifier: id }, []), true);
  }
  for (const applicationUserModelId of [null, '', aumid + 'x', 'invalid']) {
    assert.equal(historyApplicationId({ ...app, applicationUserModelId }), null);
  }
  assert.equal(
    historyApplicationBlocked({}, []),
    false,
    'legacy name-only evidence remains readable',
  );
  assert.equal(historyApplicationBlocked(app, [`winapp.${aumid.toLowerCase()}`]), true);
  assert.equal(historyApplicationBlocked(app, ['WIN32.SHAREDHOST']), true);
  assert.equal(historyApplicationBlocked(app, ['win32.otherhost']), false);
  assert.equal(
    historyApplicationBlocked({ bundleIdentifier: 'com.apple.Safari' }, ['com.apple.safari']),
    false,
  );
});

test('history search shares width, composition and case normalization with deduplicated terms', () => {
  assert.deepEqual(
    computerHistorySearchTerms(
      '  \uff2d\uff41\uff4b\uff41\tMAKA Cafe\u0301 CAF\u00c9\n\u56de\u5f52 ',
    ),
    ['maka', 'caf\u00e9', '\u56de\u5f52'],
  );
  assert.deepEqual(computerHistorySearchTerms(' \t\n '), []);
  assert.equal(computerHistorySearchNormalize('\uff21PI \u0130'), 'api i\u0307');
});

test('history search rejects invalid and excessive queries without truncating AND terms', () => {
  assert.equal(computerHistorySearchTerms('x'.repeat(128))[0]?.length, 128);
  assert.equal(computerHistorySearchTerms(Array(16).fill('maka').join(' ')).length, 1);
  const terms = Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(31, 'x'));
  assert.equal(computerHistorySearchTerms(terms.join(' ') + ' ').length, 16);
  for (const query of [
    undefined,
    null,
    1,
    [],
    {},
    ' '.repeat(513),
    'x'.repeat(129),
    [...terms, 'extra'].join(' '),
    '\ufdfa'.repeat(40),
  ]) {
    assert.throws(() => computerHistorySearchTerms(query as string), {
      message: 'Invalid Computer History search query',
    });
  }
  assert.throws(() => computerHistorySearchExcerpt('body', 'x'.repeat(129)));
});

test('history normalization stays stable through controller, main and renderer matching', () => {
  for (const raw of ['J\u030c', '\u03d2\u0301', '\u03d2\u0308', '\u1e9b\u0323']) {
    const wire = computerHistorySearchTerms(raw).join(' ');
    assert.equal(computerHistorySearchNormalize(wire), wire);
    const excerpt = computerHistorySearchExcerpt(`Document ${raw} content`, wire);
    const fields = computerHistorySearchNormalize(excerpt);
    assert.ok(
      computerHistorySearchTerms(raw).every((term) => fields.includes(term)),
      raw,
    );
  }
});

test('history search finds every distant body term beyond chat context within a fixed excerpt bound', () => {
  const terms = Array.from({ length: 16 }, (_, i) => `Token${i}`.padEnd(31, 'z'));
  const body = 'a'.repeat(13_000) + terms.map((term) => `${term}${'b'.repeat(1800)}`).join('');
  const excerpt = computerHistorySearchExcerpt(body, terms.join(' '));
  assert.ok(excerpt.length <= COMPUTER_HISTORY_SEARCH_EXCERPT_MAX_CHARS);
  for (const term of terms) assert.ok(excerpt.includes(term.toLowerCase()), term);
  assert.equal(excerpt, computerHistorySearchExcerpt(body, terms.join(' ')));
  assert.equal(computerHistorySearchExcerpt(body, ''), '');
  assert.equal(computerHistorySearchExcerpt(body, 'not-present'), '');
});

test('history excerpts preserve body token membership without joining unrelated spans or adding punctuation', () => {
  const body = `alpha${'x'.repeat(400)}omega`;
  const query = 'alpha omega xxomega ... missing';
  const excerpt = computerHistorySearchExcerpt(body, query);
  const normalizedBody = computerHistorySearchNormalize(body);
  for (const term of computerHistorySearchTerms(query)) {
    assert.equal(excerpt.includes(term), normalizedBody.includes(term), term);
  }
  assert.ok(
    excerpt.includes('\n'),
    'separated hits are never concatenated into an artificial token',
  );
  const nearby = 'One project Alpha and Omega';
  assert.equal(computerHistorySearchExcerpt(nearby, 'alpha omega'), nearby.toLowerCase());
});

test('history excerpts normalize expanding text and retain raw angle delimiters without breaking surrogate pairs', () => {
  const body = `${'\u{1f600}'.repeat(7000)}\uff21PI Cafe\u0301 \u0130 <AXWebArea> \u337f`;
  const query = 'api caf\u00e9 i\u0307 <axwebarea> \u682a\u5f0f\u4f1a\u793e';
  const excerpt = computerHistorySearchExcerpt(body, query);
  for (const term of computerHistorySearchTerms(query)) assert.ok(excerpt.includes(term), term);
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(excerpt)), excerpt);
  assert.ok(excerpt.length <= COMPUTER_HISTORY_SEARCH_EXCERPT_MAX_CHARS);
  assert.ok(body.includes('\uff21PI'), 'search never rewrites the stored body');
});
