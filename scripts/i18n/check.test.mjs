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
import { extractMarkers, parseIcuParams } from './check.mjs';

test('parseIcuParams rejects unclosed plural/select blocks, unclosed quotes, duplicates, and type conflicts', () => {
  for (const invalid of [
    '{count, plural, other {# items}',
    '{kind, select, a {A} other {B}',
    "Use '{foo} {bar}",
    '{x, select, a {A} other {B}} {x, plural, other {#}}',
    '{x, plural, other {#}} {x, select, a {A} other {B}}',
    '{count, plural, one {a} one {b} other {c}}',
    '{kind, select, a {A} a {B} other {C}}',
  ]) {
    assert.throws(() => parseIcuParams(invalid), `expected error for: ${invalid}`);
  }

  for (const strictOnly of ['Hello } world', 'Hello {1} world']) {
    assert.throws(
      () => parseIcuParams(strictOnly, { strictBraces: true }),
      `expected strict error for: ${strictOnly}`,
    );
  }
});

test('parseIcuParams keeps # literal outside plural and allows # inside nested select under plural', () => {
  assert.deepEqual(parseIcuParams("Issue '#12 failed: {reason}"), [['reason', 'text']]);
  assert.deepEqual(
    parseIcuParams('{count, plural, other {{kind, select, a {# items} other {# things}}}}'),
    [
      ['count', 'count'],
      ['kind', 'text'],
    ],
  );
  // Raw JSON examples in workbench strings remain valid in non-strict mode
  assert.deepEqual(
    parseIcuParams('Example: {"provider":{"only":["openrouter"]}}', { strictBraces: false }),
    [],
  );
});

test('extractMarkers preserves exact order and duplicate closing tags', () => {
  const prefixes = [
    '<!-- named-browser-documents -->',
    '<!-- browser-document:',
    '<!-- /browser-document -->',
  ];
  const full =
    '<!-- named-browser-documents --><!-- browser-document: a -->1<!-- /browser-document --><!-- browser-document: b -->2<!-- /browser-document -->';
  const droppedClose =
    '<!-- named-browser-documents --><!-- browser-document: a -->1<!-- /browser-document --><!-- browser-document: b -->2';
  const swapped =
    '<!-- named-browser-documents --><!-- browser-document: b -->2<!-- /browser-document --><!-- browser-document: a -->1<!-- /browser-document -->';

  assert.equal(extractMarkers(full, prefixes).length, 5);
  assert.notDeepEqual(extractMarkers(full, prefixes), extractMarkers(droppedClose, prefixes));
  assert.notDeepEqual(extractMarkers(full, prefixes), extractMarkers(swapped, prefixes));
});
