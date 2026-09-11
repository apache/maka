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
import { describe, test } from 'node:test';
import {
  EMPTY_LISTED_SELECTION,
  listedSelectionMasterState,
  pruneListedSelection,
  setAllListedSelected,
  toggleListedSelection,
  type ListedSelection,
} from '../listed-selection.js';

const LISTED = ['a', 'b', 'c'];

function ids(selection: ListedSelection): string[] {
  return [...selection.selectedIds].sort();
}

function mark(selection: ListedSelection, id: string): ListedSelection {
  return toggleListedSelection(selection, id, true);
}

describe('toggleListedSelection', () => {
  test('marks and unmarks one id', () => {
    const one = mark(EMPTY_LISTED_SELECTION, 'b');
    assert.deepEqual(ids(one), ['b']);
    assert.deepEqual(ids(toggleListedSelection(one, 'b', false)), []);
  });

  test('a toggle that changes nothing returns the same value', () => {
    // Identity is the render boundary for a list of rows: a fresh Set for a
    // click that changed nothing re-renders all of them.
    const one = mark(EMPTY_LISTED_SELECTION, 'b');
    assert.equal(toggleListedSelection(one, 'b', true), one);
    assert.equal(toggleListedSelection(one, 'c', false), one);
  });

  test('the input is never mutated', () => {
    const one = mark(EMPTY_LISTED_SELECTION, 'b');
    mark(one, 'c');
    assert.deepEqual(ids(one), ['b']);
  });
});

describe('setAllListedSelected', () => {
  test('marks exactly what the surface listed', () => {
    // A paged catalog does not know its own total and a filtered one is showing
    // a subset on purpose, so "all" can only mean the rows under the box.
    assert.deepEqual(ids(setAllListedSelected(LISTED, true)), ['a', 'b', 'c']);
  });

  test('unticking settles on the shared empty value', () => {
    assert.equal(setAllListedSelected(LISTED, false), EMPTY_LISTED_SELECTION);
  });
});

describe('listedSelectionMasterState', () => {
  test('reads unchecked, indeterminate, then checked', () => {
    assert.equal(listedSelectionMasterState(EMPTY_LISTED_SELECTION, LISTED), false);
    assert.equal(listedSelectionMasterState(mark(EMPTY_LISTED_SELECTION, 'b'), LISTED), 'indeterminate');
    assert.equal(listedSelectionMasterState(setAllListedSelected(LISTED, true), LISTED), true);
  });

  test('an empty list is unchecked, never checked', () => {
    // `every` over an empty array is vacuously true, which would tick the box
    // above no rows at all.
    assert.equal(listedSelectionMasterState(setAllListedSelected([], true), []), false);
    assert.equal(listedSelectionMasterState(mark(EMPTY_LISTED_SELECTION, 'a'), []), false);
  });

  test('a mark outside the listed ids cannot make it checked', () => {
    const stray = mark(EMPTY_LISTED_SELECTION, 'zzz');
    assert.equal(listedSelectionMasterState(stray, LISTED), 'indeterminate');
  });
});

describe('pruneListedSelection', () => {
  test('drops ids the surface no longer lists', () => {
    const all = setAllListedSelected(LISTED, true);
    assert.deepEqual(ids(pruneListedSelection(all, ['a', 'c'])), ['a', 'c']);
  });

  test('returns the same value when nothing was dropped', () => {
    const one = mark(EMPTY_LISTED_SELECTION, 'a');
    assert.equal(pruneListedSelection(one, LISTED), one);
  });

  test('an emptied result settles on the shared empty value', () => {
    assert.equal(pruneListedSelection(mark(EMPTY_LISTED_SELECTION, 'a'), []), EMPTY_LISTED_SELECTION);
  });

  test('accepts a Set without rebuilding it', () => {
    // The import page passes the ids it already has; re-wrapping a Set per
    // render is work a derived read cannot afford.
    const all = setAllListedSelected(LISTED, true);
    assert.deepEqual(ids(pruneListedSelection(all, new Set(['b']))), ['b']);
  });
});
