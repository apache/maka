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
  EMPTY_SESSION_SELECTION,
  enterSessionSelection,
  exitSessionSelection,
  pruneSessionSelection,
  sessionSelectionMasterState,
  setAllSessionsSelected,
  type SessionSelection,
} from '../../renderer/features/session-navigation/testing.js';

const GROUP = ['a', 'b', 'c', 'd', 'e'];

function ids(selection: SessionSelection): string[] {
  return [...selection.selectedIds].sort();
}

/** What a row's checkbox does, as the hook applies it. */
function mark(selection: SessionSelection, sessionId: string): SessionSelection {
  return {
    active: true,
    selectedIds: new Set([...selection.selectedIds, sessionId]),
  };
}

describe('selection mode', () => {
  test('entering marks nothing on its own', () => {
    const entered = enterSessionSelection(EMPTY_SESSION_SELECTION);
    assert.equal(entered.active, true);
    assert.deepEqual(ids(entered), []);
  });

  test('leaving drops the mode and the marks together', () => {
    assert.equal(exitSessionSelection().active, false);
    assert.deepEqual(ids(exitSessionSelection()), []);
  });

  test('unticking every row is select-none, not leave', () => {
    // A mode that ended itself on the last untick would take the checkboxes
    // away mid-gesture, and one mis-click would cost the user the way back.
    const all = setAllSessionsSelected(EMPTY_SESSION_SELECTION, GROUP, true);
    const none = setAllSessionsSelected(all, GROUP, false);
    assert.deepEqual(ids(none), []);
    assert.equal(none.active, true);
  });

  test('an emptied selection keeps the mode it was in', () => {
    // It used to settle on the shared EMPTY value, which also carries
    // `active: false` — so a catalog change that pruned the last row would have
    // taken the checkboxes away while the user was still selecting.
    const pruned = pruneSessionSelection(mark(EMPTY_SESSION_SELECTION, 'a'), []);
    assert.deepEqual(ids(pruned), []);
    assert.equal(pruned.active, true);
  });
});

describe('the master box', () => {
  test('marks exactly the rows the rail is listing', () => {
    // Not every task in the catalog: the box sits above these rows, and a
    // selection that reached past them would name a number nobody agreed to.
    assert.deepEqual(ids(setAllSessionsSelected(EMPTY_SESSION_SELECTION, ['a', 'b'], true)), [
      'a',
      'b',
    ]);
  });

  test('reads unchecked, indeterminate, then checked', () => {
    assert.equal(sessionSelectionMasterState(EMPTY_SESSION_SELECTION, GROUP), false);
    assert.equal(sessionSelectionMasterState(mark(EMPTY_SESSION_SELECTION, 'b'), GROUP), 'indeterminate');
    assert.equal(
      sessionSelectionMasterState(setAllSessionsSelected(EMPTY_SESSION_SELECTION, GROUP, true), GROUP),
      true,
    );
  });

  test('an empty list is unchecked, never checked', () => {
    // `every` over an empty array is vacuously true, which would tick the box
    // above no rows at all.
    assert.equal(sessionSelectionMasterState(EMPTY_SESSION_SELECTION, []), false);
  });

  test('a mark outside the listed rows does not make it checked', () => {
    assert.equal(sessionSelectionMasterState(mark(EMPTY_SESSION_SELECTION, 'zzz'), GROUP), 'indeterminate');
  });
});

describe('pruneSessionSelection', () => {
  test('drops ids the catalog no longer lists', () => {
    const selection = setAllSessionsSelected(EMPTY_SESSION_SELECTION, ['a', 'b'], true);
    assert.deepEqual(ids(pruneSessionSelection(selection, ['a'])), ['a']);
  });

  test('returns the same value when nothing was dropped', () => {
    // Identity matters here: this runs on every catalog refresh, and a new Set
    // each time would re-render every row of the rail.
    const selection = mark(EMPTY_SESSION_SELECTION, 'a');
    assert.equal(pruneSessionSelection(selection, ['a', 'b']), selection);
  });
});
