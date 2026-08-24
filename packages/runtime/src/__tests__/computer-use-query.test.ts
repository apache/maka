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

// Showing part of a window, without making the rest unreachable.
//
// Some windows are too big to read. Finder observes at 1,226 elements and about
// 14,700 tokens, VS Code at 986 and 14,100. Almost none of that is structural
// noise a collapse could remove — Finder's bulk is 481 cells and 363 static
// texts, which are the file list, and that is the content. The only way past a
// tree that large is to stop asking for all of it.
//
// cua-driver's `get_window_state.query` is the design this follows, including
// the part that makes it safe: "The element_index values are unchanged —
// filtering only trims the rendered Markdown."
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderObservationForModel } from '../computer-use-observation-text.js';
import type { CuObservation, CuObservedElement } from '../computer-use-types.js';

function element(
  elementId: string,
  role: string,
  extra: Partial<CuObservedElement> = {},
): CuObservedElement {
  return { elementId, role, ...extra };
}

/** A window shaped like a file list: a deep row nobody would read in full. */
function observation(query?: string): CuObservation {
  return {
    observationId: 'obs_1',
    appId: 'com.apple.finder',
    pid: 1,
    windowId: 2,
    windowTitle: '应用程序',
    elements: [
      element('0', 'AXWindow', { label: '应用程序' }),
      element('1', 'AXScrollArea', { parentElementId: '0', actions: ['scroll_up'] }),
      element('2', 'AXOutline', { parentElementId: '1', label: '边栏' }),
      element('3', 'AXRow', { parentElementId: '2' }),
      element('4', 'AXCell', { parentElementId: '3', actions: ['open'] }),
      element('5', 'AXStaticText', { parentElementId: '4', value: '下载' }),
      element('6', 'AXRow', { parentElementId: '2' }),
      element('7', 'AXCell', { parentElementId: '6', actions: ['open'] }),
      element('8', 'AXStaticText', { parentElementId: '7', value: '文稿' }),
      element('9', 'AXButton', { parentElementId: '0', label: '共享' }),
    ],
    ...(query ? { query } : {}),
  } as CuObservation;
}

test('a query keeps what matched and every element containing it', () => {
  const text = renderObservationForModel(observation('下载'));
  const rows = text.split('\n').filter((line) => /^\t*\d/.test(line));
  // The ancestors are the point: a bare match is a line with no place in the
  // window, and the indentation that says where it sits is why this is a tree.
  assert.deepEqual(
    rows.map((line) => line.trim().split(' ')[0]),
    ['0', '1', '2', '3', '4', '5'],
  );
  assert.doesNotMatch(text, /文稿/);
  assert.doesNotMatch(text, /共享/);
});

test('ids are the ids of the whole window, so a match can be acted on directly', () => {
  const text = renderObservationForModel(observation('下载'));
  // `4` is the cell's id in the unfiltered observation too. If filtering
  // renumbered, a model would have to re-observe before it could click what it
  // had just found — which is the round trip this exists to save.
  assert.match(text, /4 AXCell \+open/);
  const whole = renderObservationForModel(observation());
  assert.match(whole, /4 AXCell \+open/);
});

test('a filtered tree says so, beside the count it contradicts', () => {
  const text = renderObservationForModel(observation('下载'));
  // Without this the model reads a filtered tree as the whole window, and "the
  // control is not there" is the conclusion it draws.
  assert.match(text, /elements=10/);
  assert.match(text, /query="下载"\(showing 6 of 10/);
  assert.match(text, /Observe without a query for the rest/);
});

test('a query matching nothing is empty rather than everything', () => {
  const text = renderObservationForModel(observation('没有这个'));
  const rows = text.split('\n').filter((line) => /^\t*\d/.test(line));
  // Falling back to the whole tree would answer a narrow question with 14,000
  // tokens, which is the failure this is here to prevent.
  assert.deepEqual(rows, []);
  assert.match(text, /showing 0 of 10/);
});

test('a query matches a role and a value, not only a label', () => {
  // `下载` is a value; `AXButton` is a role. Both are what a model has in front
  // of it when it decides what to search for.
  assert.match(renderObservationForModel(observation('AXButton')), /9 AXButton "共享"/);
  assert.match(renderObservationForModel(observation('共享')), /9 AXButton "共享"/);
});
