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

// packages/ui/src/use-roving-row-focus.ts
//
// Roving tabindex over a selectable list, so the whole list is ONE tab stop.
//
// Why this exists: a list of N selectable rows where every per-item action
// lives in an inspector AFTER the list puts the inspector N−k tab presses away
// from row k. The row is the cheap part of the journey and the actions are the
// expensive part, which is backwards. Arrow keys are the right instrument for
// moving inside a homogeneous set; Tab is for moving between regions, and it
// should cost one press to leave the list no matter which row you are on.
//
// The rows are rendered by the design system's List/ListItem, which owns the
// focusable element itself — an "invisible button" inside each `li` that takes
// no `tabIndex` from the call site. So the tabindex is written onto those
// buttons directly, in a layout effect, which is the same DOM seam the panel
// already reaches through to restore focus after a delete. Focus itself stays
// where the user put it: arrows move focus, Enter/Space select, and selection
// never follows focus — the inspector is too expensive a side effect to fire
// on a plain arrow press.

import { useCallback, useLayoutEffect, useState, type KeyboardEvent, type FocusEvent, type RefObject } from 'react';

/** The design system renders one invisible button per interactive row. */
const ROW_BUTTON_SELECTOR = 'li button';

export interface RovingRowFocusProps {
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onFocus(event: FocusEvent<HTMLElement>): void;
}

/**
 * Spread the returned props on the element containing the rows. Rows are read
 * from the DOM rather than tracked as refs because the list markup belongs to
 * the design system, and the row order is exactly the DOM order.
 */
export function useRovingRowFocus(containerRef: RefObject<HTMLElement | null>): RovingRowFocusProps {
  const [activeIndex, setActiveIndex] = useState(0);
  // Read inside every callback: the effect below runs after each render, but a
  // key press can land between a data update and that render.
  const readRows = useCallback(
    () => Array.from(containerRef.current?.querySelectorAll<HTMLElement>(ROW_BUTTON_SELECTOR) ?? []),
    [containerRef],
  );
  // No dependency array on purpose, and it is load-bearing twice over. React
  // never wrote these tabindexes, so it cannot restore them: any render that
  // mounts a fresh row button — a new reminder, a filter change — hands us a
  // node at its default tabindex 0, which puts the list back in the tab order.
  // And the stop has to follow `activeIndex` after every arrow press, or Tab
  // out and back would return to whichever row the user left long ago.
  // Running on every render is what covers both; it is also why this reads
  // `activeIndex` straight from the render closure rather than through a ref.
  useLayoutEffect(() => {
    const rows = readRows();
    if (rows.length === 0) return;
    // Clamp rather than reset: when the active row is deleted, the row that
    // took its place is the one that should still hold the list's tab stop.
    const active = Math.min(activeIndex, rows.length - 1);
    for (const [index, row] of rows.entries()) row.tabIndex = index === active ? 0 : -1;
  });

  const focusRow = useCallback(
    (index: number) => {
      const rows = readRows();
      if (rows.length === 0) return;
      const next = Math.max(0, Math.min(index, rows.length - 1));
      setActiveIndex(next);
      rows[next]?.focus();
    },
    [readRows],
  );

  return {
    onKeyDown(event) {
      const rows = readRows();
      const current = rows.indexOf(document.activeElement as HTMLElement);
      // Focus is on something else inside the container (the clear-search
      // button, a control in an empty state) — those keys are not ours.
      if (current < 0) return;
      switch (event.key) {
        case 'ArrowDown':
          focusRow(current + 1);
          break;
        case 'ArrowUp':
          focusRow(current - 1);
          break;
        case 'Home':
          focusRow(0);
          break;
        case 'End':
          focusRow(rows.length - 1);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    onFocus(event) {
      // Whatever the user reaches by click, by Tab, or by the panel's own
      // post-delete focus restore becomes the list's tab stop.
      const index = readRows().indexOf(event.target as HTMLElement);
      if (index >= 0) setActiveIndex(index);
    },
  };
}
