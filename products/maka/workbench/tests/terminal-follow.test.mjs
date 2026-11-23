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
import { createTerminalFollow } from '../app/terminalFollow.ts';

const LINE = 19;
const ROWS = 24;
const end = (totalRows) => Math.max(0, totalRows - ROWS);
// One complete user gesture: the intent, its animated reports, and rest at
// the last offset.
const wheel = (follow, totalRows, ...ys) => {
  follow.intent(totalRows, ROWS);
  for (const y of ys) {
    follow.scrolled(y * LINE, totalRows, ROWS);
  }
  follow.scrollEnd(ys.at(-1) * LINE, totalRows, ROWS);
};

test('a wheel glide settles where it comes to rest', () => {
  const follow = createTerminalFollow(LINE);
  follow.intent(40, ROWS);
  // Every report of the glide settles; the rest is the last one.
  follow.scrolled((end(40) - 1) * LINE, 40, ROWS);
  follow.scrolled((end(40) - 3) * LINE, 40, ROWS);
  follow.scrollEnd((end(40) - 3) * LINE, 40, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.displayOffset(40, ROWS), 3);
});

test('wheeling down to the end resumes following at the rest', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 8);
  assert.equal(follow.state.atBottom, false);
  wheel(follow, 40, end(40) - 4, end(40));
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(40, ROWS), 0);
});

test('a retargeted wheel notch settles where it comes to rest', () => {
  const follow = createTerminalFollow(LINE);
  follow.intent(40, ROWS);
  follow.scrolled((end(40) - 2) * LINE, 40, ROWS);
  // A second notch during the glide moves the goal; the rest is what counts.
  follow.intent(40, ROWS);
  follow.scrolled((end(40) - 7) * LINE, 40, ROWS);
  follow.scrollEnd((end(40) - 7) * LINE, 40, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.displayOffset(40, ROWS), 7);
});

test('a delayed automatic report after a later batch keeps following', () => {
  const follow = createTerminalFollow(LINE);
  // The user scrolled up and back to the end; the gesture closed at rest.
  wheel(follow, 40, end(40) - 6);
  wheel(follow, 40, end(40));
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.active(), false);
  // The follow effect of batch 30 scrolled to its end; the report arrives
  // after batch 40 grew the grid, so its old offset is measured against the
  // new extent. No gesture is open, so it is ignored.
  follow.scrolled(end(30) * LINE, 40, ROWS);
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(40, ROWS), 0);
});

test('a programmatic report leaves the reader where it is', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  // Output grows the grid; the app's own pin, a reflow and contentOffset
  // all report without a gesture and must not move the reading row.
  follow.scrolled(end(40) * LINE, 50, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.displayOffset(50, ROWS), 20);
});

test('reading history stays aligned as new output arrives', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  assert.equal(follow.displayOffset(40, ROWS), 10);
  // New output grows the grid; the anchored top row stays put and the
  // bottom-relative offset derives from the current extent.
  assert.equal(follow.displayOffset(50, ROWS), 20);
  assert.equal(follow.displayOffset(60, ROWS), 30);
});

test('a reflow that shrinks the grid keeps the reading row', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  // The grid reflows to fewer rows: the anchored row is kept, and a shrink
  // below it clamps to the end instead of jumping to the oldest rows.
  assert.equal(follow.displayOffset(34, ROWS), 4);
  assert.equal(follow.displayOffset(30, ROWS), 0);
});

test('shift+pageup and shift+pagedown navigate directly and resume following at the end', () => {
  const follow = createTerminalFollow(LINE);
  follow.pageUp(60, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.physicalY(60, ROWS), (end(60) - ROWS) * LINE);
  // The programmatic scrollTo report carries no gesture and is ignored.
  follow.scrolled((end(60) - ROWS) * LINE, 60, ROWS);
  follow.scrollEnd((end(60) - ROWS) * LINE, 60, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.physicalY(60, ROWS), (end(60) - ROWS) * LINE);
  follow.pageDown(60, ROWS);
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(60, ROWS), 0);
  // A pane with nothing to scroll keeps following.
  follow.pageUp(5, ROWS);
  assert.equal(follow.state.atBottom, true);
});

test('a wheel at an edge is abandoned and later reports stay programmatic', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  // A wheel at a scroll edge: the intent moves nothing, so no report and no
  // ScrollEnd follow, and the window is abandoned when it goes quiet.
  follow.intent(40, ROWS);
  follow.abandon((end(40) - 10) * LINE, 40, ROWS);
  assert.equal(follow.active(), false);
  follow.scrolled(end(40) * LINE, 50, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.displayOffset(50, ROWS), 20);
});

test('a wheel at the bottom edge that never moved keeps following', () => {
  const follow = createTerminalFollow(LINE);
  // Following at the bottom; the wheel hits the edge and nothing moves
  // while output keeps growing the bottom away.
  follow.intent(40, ROWS);
  follow.abandon(end(40) * LINE, 46, ROWS);
  assert.equal(follow.active(), false);
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(46, ROWS), 0);
});

test('a wheel back to the bottom while output arrives resumes following', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  // The glide is clamped to the bottom the gesture started from; output
  // grows the grid during it, so the rest sits above the new bottom.
  follow.intent(40, ROWS);
  follow.scrolled(end(40) * LINE, 46, ROWS);
  follow.scrollEnd(end(40) * LINE, 46, ROWS);
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(46, ROWS), 0);
});

test('a wheel that stops above the bottom it started from keeps reading', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  follow.intent(40, ROWS);
  follow.scrolled((end(40) - 6) * LINE, 46, ROWS);
  follow.scrollEnd((end(40) - 6) * LINE, 46, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.displayOffset(46, ROWS), 12);
});

test('a report after ScrollEnd is ignored', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  follow.intent(40, ROWS);
  follow.scrolled(end(40) * LINE, 46, ROWS);
  follow.scrollEnd(end(40) * LINE, 46, ROWS);
  assert.equal(follow.state.atBottom, true);
  // The final report of the glide arrives after ScrollEnd, with no gesture
  // open, so it is ignored.
  follow.scrolled(end(40) * LINE, 46, ROWS);
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(46, ROWS), 0);
});

test('a drag to the bottom while output arrives resumes following', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  follow.dragStart(40, ROWS);
  follow.scrolled(10 * LINE, 46, ROWS);
  follow.scrolled((end(40) + 1) * LINE, 46, ROWS);
  follow.scrollEnd((end(40) + 1) * LINE, 46, ROWS);
  assert.equal(follow.state.atBottom, true);
});

test('a report without a user gesture is programmatic and ignored', () => {
  const follow = createTerminalFollow(LINE);
  follow.scrolled((end(40) - 5) * LINE, 40, ROWS);
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(40, ROWS), 0);
  // While reading, such a report must not move the anchor either.
  wheel(follow, 40, end(40) - 10);
  follow.scrolled((end(40) - 30) * LINE, 50, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.displayOffset(50, ROWS), 20);
});

test('a drag settles where it is released', () => {
  const follow = createTerminalFollow(LINE);
  follow.dragStart(40, ROWS);
  assert.equal(follow.active(), true);
  follow.scrolled((end(40) - 5) * LINE, 40, ROWS);
  assert.equal(follow.state.atBottom, false);
  follow.scrolled((end(40) - 12) * LINE, 40, ROWS);
  follow.scrollEnd((end(40) - 12) * LINE, 40, ROWS);
  assert.equal(follow.active(), false);
  assert.equal(follow.displayOffset(40, ROWS), 12);
});

test('a remounted pane restores its reading position and stays aligned', () => {
  const follow = createTerminalFollow(LINE);
  follow.restore(false, 6 * LINE, 40, ROWS);
  assert.equal(follow.state.atBottom, false);
  assert.equal(follow.displayOffset(40, ROWS), 10);
  assert.equal(follow.displayOffset(50, ROWS), 20);
  // A stored position past the shrunk end follows again.
  const shrunk = createTerminalFollow(LINE);
  shrunk.restore(false, 100 * LINE, 40, ROWS);
  assert.equal(shrunk.state.atBottom, true);
  // A remount while following restores following.
  const following = createTerminalFollow(LINE);
  following.restore(true, end(40) * LINE, 40, ROWS);
  assert.equal(following.state.atBottom, true);
});

test('a reset stream follows again', () => {
  const follow = createTerminalFollow(LINE);
  wheel(follow, 40, end(40) - 10);
  assert.equal(follow.state.atBottom, false);
  follow.reset();
  assert.equal(follow.state.atBottom, true);
  assert.equal(follow.displayOffset(5, ROWS), 0);
});
