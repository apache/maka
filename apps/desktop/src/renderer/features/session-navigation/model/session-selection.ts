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

import type { SessionRailSelectionCommands } from '@maka/ui';

/**
 * What the rail has picked, and where a Shift range starts.
 *
 * There is no `active` flag and no mode to be in. A modifier held during a
 * click is the whole vocabulary, which is what a Finder, a VS Code explorer and
 * a Codex task list all use, so there is nothing to enter, nothing to leave,
 * and no state in which a plain click means something else.
 */
export interface SessionSelection {
  readonly selectedIds: ReadonlySet<string>;
  /**
   * The row a Shift range extends from: the last row picked WITHOUT Shift.
   * Undefined until one is, and again after a clear — a range then starts from
   * whatever is open, which is where the user's attention already is.
   */
  readonly anchorId: string | undefined;
}

/**
 * What one click asks of the set — the rail's own contract, not a second copy
 * of it. The rail is where the gesture is read, so the vocabulary is declared
 * there and this reducer answers exactly the request the rail sends.
 */
export type SessionPickRequest = Parameters<SessionRailSelectionCommands['pick']>[0];

/**
 * Nothing picked, no anchor — where the rail starts, and what a clear returns
 * to.
 *
 * Clearing is not "collapse to the open row": the open row is painted by the
 * rail whether or not it is picked, so an empty selection already reads as that
 * one row, and a set of one that happens to equal the open row is a second way
 * to say the same thing.
 */
export const EMPTY_SESSION_SELECTION: SessionSelection = Object.freeze({
  selectedIds: Object.freeze(new Set<string>()) as ReadonlySet<string>,
  anchorId: undefined,
});

/**
 * Drops ids the catalog no longer lists.
 *
 * A selection outlives the list it was made from: another client deletes a
 * task, a filter narrows, an archive sweep removes what it removed. Acting on
 * an id that is gone is at best a no-op and at worst a count that does not add
 * up, so the selection is reconciled against the catalog rather than trusted.
 * The anchor is reconciled with it — a range from a row that is no longer there
 * would reach across the rows that took its place.
 */
export function pruneSessionSelection(
  selection: SessionSelection,
  listedSessionIds: Iterable<string>,
): SessionSelection {
  const listed = listedSessionIds instanceof Set ? listedSessionIds : new Set(listedSessionIds);
  const selectedIds = new Set<string>();
  for (const sessionId of selection.selectedIds) {
    if (listed.has(sessionId)) selectedIds.add(sessionId);
  }
  const anchorId =
    selection.anchorId !== undefined && listed.has(selection.anchorId)
      ? selection.anchorId
      : undefined;
  if (selectedIds.size === selection.selectedIds.size && anchorId === selection.anchorId) {
    return selection;
  }
  return { selectedIds, anchorId };
}

/**
 * Applies one click to the selection.
 *
 * `orderedSessionIds` is the rail's RENDERED order, and it is an argument
 * rather than state for the reason the rows never receive it: it is a property
 * of the list, it changes identity whenever the catalog does, and #4365's first
 * revision handed each row its group's copy — a changed prop on every memoised
 * row, which turned a two-row session switch into a twelve-row one (#4109).
 * Read at the moment of a click it costs one query and nothing per render.
 *
 * A range runs from the anchor, and the anchor does NOT move: a range can be
 * re-dragged shorter or longer from the same origin, and the task the main pane
 * is showing stays the one the user opened.
 */
export function pickSessionRow(
  selection: SessionSelection,
  input: SessionPickRequest,
): SessionSelection {
  const { sessionId, pick, orderedSessionIds, openSessionId } = input;
  if (pick === 'replace') return { selectedIds: new Set([sessionId]), anchorId: sessionId };
  if (pick === 'toggle') {
    const selectedIds = new Set(selection.selectedIds);
    if (!selectedIds.delete(sessionId)) selectedIds.add(sessionId);
    return { selectedIds, anchorId: sessionId };
  }
  const anchorId = selection.anchorId ?? openSessionId;
  const from = anchorId === undefined ? -1 : orderedSessionIds.indexOf(anchorId);
  const to = orderedSessionIds.indexOf(sessionId);
  // No anchor to reach from, or a row the list is not showing: the range is the
  // one row that was actually clicked.
  if (from === -1 || to === -1) return { selectedIds: new Set([sessionId]), anchorId: sessionId };
  const run = orderedSessionIds.slice(Math.min(from, to), Math.max(from, to) + 1);
  return { selectedIds: new Set(run), anchorId };
}
