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

// The terminal's reading position and output-following decision.
//
// NSH coalesces scroll reports to one per frame and does not snapshot the
// geometry a report was produced against: a delayed report for an earlier
// batch carries its old offset while the engine fills in the current content
// size. Its `delta` cannot tell them apart either — a plain Scroll reports
// the displacement of the app's own scrollTo/scrollToEnd too (only Lists
// exclude core-issued scrolls). So reports are classified by the gesture
// that owns them, not by what they carry.
//
// The intent/drag window (TurnPanel's idle/pending/dragging machine) is that
// owner: onScrollIntent and onScrollDragStart open it, reports inside it
// settle the reading position, and every report while idle is the app's own
// pin or a stale report and is ignored. It also keeps the follow effect from
// pinning the viewport while a gesture is in flight, where pinning at an
// intermediate anchor would fight the glide. A wheel at a scroll edge emits
// an intent but then no report and no ScrollEnd, so the window is also
// abandoned when it goes quiet (abandon()). A wheel glides to its rest over
// several reports and ends with ScrollEnd, which settles the rest.
//
// A gesture remembers the bottom it started from. A wheel's glide is clamped
// to the content that existed when its notch was read, so output arriving
// during the glide leaves the rest a few rows above the bottom that exists
// when it ends. A rest at the gesture's bottom is the user returning to the
// bottom, not a reading position, and resumes following; a rest above it
// settles the reading anchor. Reports after the gesture closes are ignored
// like any other programmatic report.
//
// Gesture geometry must be the content the Scroll clamps against — the last
// frame the pane rendered — not the live grid, which can run a batch ahead
// while output streams and would put the gesture's bottom past the rest.
//
// While not following, the reading position is anchored from the top
// (absolute row of the first visible row), the same coordinate the
// Scroll's physical y uses. The bottom-relative offset the grid display
// wants is derived from the current totalRows on every frame, so new
// output, resize and remount keep the rendered slice aligned with the
// physical viewport by construction. The grid caps its scrollback and
// rotates the oldest rows away once full; that rotation is not observable
// through the grid's history size, and the emulator's own display offset
// drifts with it the same way, so a reader at the cap drifts with the
// output instead of staying fixed.

export type FollowState = {
  atBottom: boolean;
};

type ScrollInput = 'idle' | 'pending' | 'dragging';

export function createTerminalFollow(line: number) {
  const state: FollowState = { atBottom: true };
  let scrollInput: ScrollInput = 'idle';
  // Absolute row of the first visible row while reading history; null
  // while following. Top-relative, like the Scroll's physical y.
  let anchor: number | null = null;
  // The bottom when the current gesture asked to scroll.
  let gestureBottom: number | null = null;
  // Whether the current gesture moved the view. A wheel at an edge opens a
  // window that never moves, reports or ends; it leaves the reading state
  // alone.
  let moved = false;

  const end = (totalRows: number, rows: number) => Math.max(0, totalRows - rows);

  const settle = (y: number, totalRows: number, rows: number, gesture: boolean) => {
    const bottom = end(totalRows, rows);
    const top = Math.max(0, Math.min(Math.floor(y / line), bottom));
    state.atBottom =
      bottom - top <= 1 || (gesture && gestureBottom !== null && top >= gestureBottom - 1);
    anchor = state.atBottom ? null : top;
  };

  return {
    state,
    /** `onScrollIntent`: the user asked to scroll, before the offset moves. */
    intent(totalRows: number, rows: number) {
      if (scrollInput === 'dragging') return;
      if (scrollInput === 'idle') moved = false;
      scrollInput = 'pending';
      gestureBottom = end(totalRows, rows);
    },
    /** `onScrollDragStart`: the user grabbed the scrollbar or flung. */
    dragStart(totalRows: number, rows: number) {
      if (scrollInput !== 'dragging') moved = false;
      scrollInput = 'dragging';
      gestureBottom = end(totalRows, rows);
    },
    /**
     * `onScroll`: settle inside a user gesture. While idle, the report is
     * the app's own scroll or a delayed one for an earlier batch; it must not
     * move the reading position. Settling does not open the window: only an
     * intent or a drag does, so the viewport keeps following the moment a
     * gesture ends.
     */
    scrolled(y: number, totalRows: number, rows: number): FollowState {
      if (scrollInput === 'idle') return state;
      moved = true;
      settle(y, totalRows, rows, false);
      return state;
    },
    /** `onScrollEnd`: a gesture came to rest; settle where it stopped and close it. */
    scrollEnd(y: number, totalRows: number, rows: number): FollowState {
      settle(y, totalRows, rows, true);
      scrollInput = 'idle';
      gestureBottom = null;
      return state;
    },
    /**
     * The intent window went quiet: a wheel at a scroll edge emits an intent
     * but then no report and no ScrollEnd. A gesture that moved settles at
     * the last reported offset, which is where the edge clamped it.
     */
    abandon(y: number, totalRows: number, rows: number): FollowState {
      if (scrollInput !== 'pending') return state;
      scrollInput = 'idle';
      if (moved) {
        settle(y, totalRows, rows, true);
      }
      gestureBottom = null;
      return state;
    },
    /** Whether a user gesture owns the viewport. */
    active(): boolean {
      return scrollInput !== 'idle';
    },
    /**
     * Derive the display offset for the current grid. Call from the frame
     * computation with the latest totalRows so the anchored slice stays
     * aligned as output grows or the pane reflows.
     */
    displayOffset(totalRows: number, rows: number): number {
      if (state.atBottom || anchor === null) return 0;
      return Math.max(0, end(totalRows, rows) - anchor);
    },
    /** Shift+PageUp: direct user navigation, no report needed. */
    pageUp(totalRows: number, rows: number) {
      const bottom = end(totalRows, rows);
      scrollInput = 'idle';
      gestureBottom = null;
      if (bottom <= 0) {
        anchor = null;
        state.atBottom = true;
        return;
      }
      const top = Math.min(anchor ?? bottom, bottom);
      anchor = Math.max(0, top - rows);
      state.atBottom = bottom - anchor <= 1;
    },
    /** Shift+PageDown: direct user navigation; reaching the end resumes following. */
    pageDown(totalRows: number, rows: number) {
      const bottom = end(totalRows, rows);
      const top = Math.min(anchor ?? bottom, bottom);
      const next = Math.min(bottom, top + rows);
      state.atBottom = bottom - next <= 1;
      anchor = state.atBottom ? null : next;
      scrollInput = 'idle';
      gestureBottom = null;
    },
    /** Remount: restore the reading state the model survived with. */
    restore(atBottom: boolean, y: number, totalRows: number, rows: number): FollowState {
      scrollInput = 'idle';
      gestureBottom = null;
      if (atBottom) {
        anchor = null;
        state.atBottom = true;
      } else {
        settle(y, totalRows, rows, false);
      }
      return state;
    },
    /** The physical y the Scroll should show for the current reading state. */
    physicalY(totalRows: number, rows: number): number {
      const bottom = end(totalRows, rows);
      return Math.min(anchor ?? bottom, bottom) * line;
    },
    /** A new stream (retry): follow it from zero. */
    reset() {
      scrollInput = 'idle';
      gestureBottom = null;
      moved = false;
      anchor = null;
      state.atBottom = true;
    },
  };
}
