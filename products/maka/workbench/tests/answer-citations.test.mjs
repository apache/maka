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
import { answerSource, citationOffsets } from '../app/answerCitations.ts';
import { mergeHistoryPage } from '../app/history.ts';

const first = answerSource(
  { citation: { kind: 'url', url: 'https://www.example.org/report', title: 'Report' } },
  'first',
);
const second = answerSource(
  { citation: { kind: 'url', url: 'https://example.org/notes', title: 'Report' } },
  'second',
);
const range = (source, start, end) => ({ source, anchor: { kind: 'range', part: 0, start, end } });
const blockEnd = (source) => ({ source, anchor: { kind: 'block_end', part: 0 } });

test('range chips follow their Unicode scalar endpoints as text arrives', () => {
  const citations = [
    range(first, 0, 2),
    range(second, 1, 2),
    range(first, 1, 2),
    range(first, 2, 3),
  ];
  assert.deepEqual(citationOffsets('😀', citations), []);
  const atClaim = [
    { byte: 7, source: first },
    { byte: 7, source: second },
  ];
  assert.deepEqual(citationOffsets('😀中', citations), atClaim);
  assert.deepEqual(citationOffsets('😀中。后续', citations), [
    ...atClaim,
    { byte: 10, source: first },
  ]);
  assert.deepEqual(
    citationOffsets('😀', [range(first, 0, 0), range(first, -1, 1), range(first, 0, 2)]),
    [],
  );
});

test('a block-end chip waits for the complete history part and follows its last visible text', () => {
  const citations = [range(first, 0, 1), blockEnd(second)];
  assert.deepEqual(citationOffsets('甲', citations, 8), [{ byte: 3, source: first }]);
  assert.deepEqual(citationOffsets('甲乙\r\n', citations, 8), [
    { byte: 3, source: first },
    { byte: 6, source: second },
  ]);
  assert.deepEqual(citationOffsets('甲乙\r\n', [range(first, 0, 2), blockEnd(first)], 8), [
    { byte: 6, source: first },
  ]);
  assert.deepEqual(citationOffsets('  \n', [blockEnd(first)], 3), []);
});

test('source identity uses the URL or the document index within its request', () => {
  assert.equal(first.site, 'example.org');
  assert.equal(
    first.key,
    answerSource({ citation: { kind: 'url', url: first.url, title: 'Another title' } }, 'new').key,
  );
  assert.notEqual(first.key, second.key);
  const citation = { kind: 'document', title: 'Proceedings', documentIndex: 0 };
  const modelPart = { stepId: 'step', attemptId: 'attempt', ordinal: 1 };
  const key = answerSource({ citation, modelPart }, 'first').key;
  assert.equal(
    answerSource({ citation, modelPart: { ...modelPart, ordinal: 2 } }, 'second').key,
    key,
  );
  assert.notEqual(
    answerSource({ citation, modelPart: { ...modelPart, attemptId: 'retry' } }, 'second').key,
    key,
  );
});

test('citations survive loading the body and tail of a history source in either order', () => {
  const chunk = {
    sourceCitation: true,
    field: 'body',
    role: 'assistant',
    position: { kind: 'live', sequence: 1, fact: 1, itemIndex: 0 },
    totalBytes: 4,
    order: { path: [1], itemIndex: 0 },
  };
  const head = {
    ...chunk,
    offset: 0,
    text: 'ab',
    citation: { kind: 'url', url: first.url },
    citationAnchor: range(first, 0, 1).anchor,
  };
  const tail = { ...chunk, offset: 2, text: 'cd' };
  for (const [initial, next] of [
    [head, tail],
    [tail, head],
  ]) {
    const [previous] = mergeHistoryPage([initial], () => undefined, false, 4);
    const [merged] = mergeHistoryPage([next], () => previous, true, 3);
    assert.deepEqual(
      [merged.text, merged.citation, merged.citationAnchor],
      ['abcd', head.citation, head.citationAnchor],
    );
  }
});
