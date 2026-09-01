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
import type { SessionRowPick } from '@maka/ui';
import {
  EMPTY_SESSION_SELECTION,
  pickSessionRow,
  pruneSessionSelection,
  type SessionSelection,
} from '../../renderer/features/session-navigation/testing.js';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

function ids(selection: SessionSelection): string[] {
  return [...selection.selectedIds].sort();
}

/** One click on a row, as the rail's handler passes it down. */
function click(
  selection: SessionSelection,
  sessionId: string,
  pick: SessionRowPick,
  openSessionId?: string,
): SessionSelection {
  return pickSessionRow(selection, {
    sessionId,
    pick,
    orderedSessionIds: ORDER,
    openSessionId,
  });
}

describe('a plain click', () => {
  test('makes the set exactly this row', () => {
    const from = click(EMPTY_SESSION_SELECTION, 'a', 'replace');
    assert.deepEqual(ids(click(from, 'd', 'replace')), ['d']);
  });

  test('leaves the anchor on the row that was clicked', () => {
    // Which is what lets the very next Shift-click reach from here, without a
    // separate gesture to say where a range starts.
    const anchored = click(EMPTY_SESSION_SELECTION, 'b', 'replace');
    assert.deepEqual(ids(click(anchored, 'd', 'range')), ['b', 'c', 'd']);
  });
});

describe('⌘-click', () => {
  test('adds a row without disturbing the rest', () => {
    const one = click(EMPTY_SESSION_SELECTION, 'a', 'replace');
    assert.deepEqual(ids(click(one, 'd', 'toggle')), ['a', 'd']);
  });

  test('removes a row it finds already picked', () => {
    const two = click(click(EMPTY_SESSION_SELECTION, 'a', 'replace'), 'd', 'toggle');
    assert.deepEqual(ids(click(two, 'a', 'toggle')), ['d']);
  });

  test('moves the anchor, including when it unpicked the row', () => {
    // The anchor is "where the last non-Shift click landed", not "the last row
    // added": a person who unticks a row and then Shift-clicks means the run
    // between those two clicks, whatever the first one did to the set.
    const removed = click(click(EMPTY_SESSION_SELECTION, 'b', 'replace'), 'b', 'toggle');
    assert.deepEqual(ids(removed), []);
    assert.deepEqual(ids(click(removed, 'd', 'range')), ['b', 'c', 'd']);
  });
});

describe('Shift-click', () => {
  test('picks the run between the anchor and the row, in either direction', () => {
    const anchored = click(EMPTY_SESSION_SELECTION, 'd', 'replace');
    assert.deepEqual(ids(click(anchored, 'b', 'range')), ['b', 'c', 'd']);
  });

  test('keeps the anchor so the run can be re-dragged from the same origin', () => {
    // Shortening a range is the same gesture as lengthening it. An anchor that
    // moved to the last row touched would make the second Shift-click reach
    // from the end of the first one, and the run would only ever grow.
    const anchored = click(EMPTY_SESSION_SELECTION, 'b', 'replace');
    const long = click(anchored, 'e', 'range');
    assert.deepEqual(ids(click(long, 'c', 'range')), ['b', 'c']);
  });

  test('starts from the open task when no click has set an anchor', () => {
    // The rail is a navigation surface first: a person who has been reading a
    // task and Shift-clicks another means the two of them and everything
    // between, without a preparatory click to say so.
    assert.deepEqual(ids(click(EMPTY_SESSION_SELECTION, 'd', 'range', 'b')), ['b', 'c', 'd']);
  });

  test('with nothing to reach from is just this row', () => {
    assert.deepEqual(ids(click(EMPTY_SESSION_SELECTION, 'd', 'range')), ['d']);
  });

  test('reaching for a row the list is not showing picks only the row clicked', () => {
    const stale = pickSessionRow(EMPTY_SESSION_SELECTION, {
      sessionId: 'd',
      pick: 'range',
      orderedSessionIds: ORDER,
      openSessionId: 'gone',
    });
    assert.deepEqual(ids(stale), ['d']);
  });
});

describe('clearing', () => {
  test('drops the picks and the anchor together', () => {
    const cleared = EMPTY_SESSION_SELECTION;
    assert.deepEqual(ids(cleared), []);
    // With no anchor left, the next range starts from whatever is open —
    // which is where the user's attention already is.
    assert.deepEqual(ids(click(cleared, 'c', 'range', 'a')), ['a', 'b', 'c']);
  });
});

describe('pruneSessionSelection', () => {
  test('drops ids the catalog no longer lists', () => {
    const two = click(click(EMPTY_SESSION_SELECTION, 'a', 'replace'), 'b', 'toggle');
    assert.deepEqual(ids(pruneSessionSelection(two, ['a'])), ['a']);
  });

  test('drops an anchor that went with them', () => {
    // A range from a row that is gone would reach across the rows that took
    // its place, which is not the run anybody drew.
    const anchored = click(EMPTY_SESSION_SELECTION, 'b', 'replace');
    const pruned = pruneSessionSelection(anchored, ['a', 'c', 'd', 'e']);
    assert.deepEqual(ids(click(pruned, 'd', 'range', 'c')), ['c', 'd']);
  });

  test('returns the same value when nothing was dropped', () => {
    // Identity matters here: this runs on every catalog refresh, and a new Set
    // each time would re-render every row of the rail.
    const selection = click(EMPTY_SESSION_SELECTION, 'a', 'replace');
    assert.equal(pruneSessionSelection(selection, ['a', 'b']), selection);
  });
});
