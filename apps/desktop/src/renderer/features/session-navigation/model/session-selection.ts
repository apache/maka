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

/** What the rail has marked, and whether the mode is on at all. */
export interface SessionSelection {
  /**
   * Whether the rail is in selection mode.
   *
   * Separate from `selectedIds` being empty, because unticking the master box
   * is "select none" and not "leave". A mode that exited itself the moment the
   * last row was cleared would take the checkboxes away mid-gesture, and the
   * user would have to find the way back in to correct one mis-click.
   */
  readonly active: boolean;
  readonly selectedIds: ReadonlySet<string>;
}

export const EMPTY_SESSION_SELECTION: SessionSelection = Object.freeze({
  active: false,
  selectedIds: Object.freeze(new Set<string>()) as ReadonlySet<string>,
});

/**
 * Drops ids the catalog no longer lists.
 *
 * A selection outlives the list it was made from: another client deletes a
 * task, a filter narrows, a bulk action removes what it removed. Acting on an
 * id that is gone is at best a no-op and at worst a count that does not add up,
 * so the selection is reconciled against the catalog rather than trusted.
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
  if (selectedIds.size === selection.selectedIds.size) return selection;
  // Pruning empties the set; it does not end the mode. The rows went away
  // because the catalog changed, not because the user was finished.
  return { active: selection.active, selectedIds };
}

/** Enters selection mode with nothing marked. */
export function enterSessionSelection(selection: SessionSelection): SessionSelection {
  return selection.active ? selection : { ...selection, active: true };
}

/** Leaves selection mode and drops what was marked. */
export function exitSessionSelection(): SessionSelection {
  return EMPTY_SESSION_SELECTION;
}

/**
 * The master box: every listed row, or none of them.
 *
 * "All" means every row the rail is listing right now, which is what the user
 * can see the box sitting above — not every task in the catalog. A box that
 * silently included rows behind a collapsed project, or filtered out of view,
 * would name a number the user never agreed to.
 */
export function setAllSessionsSelected(
  selection: SessionSelection,
  listedSessionIds: readonly string[],
  selected: boolean,
): SessionSelection {
  if (!selected) return { active: selection.active, selectedIds: new Set() };
  return { active: true, selectedIds: new Set(listedSessionIds) };
}

/** What the master box shows: all, none, or some. */
export function sessionSelectionMasterState(
  selection: SessionSelection,
  listedSessionIds: readonly string[],
): boolean | 'indeterminate' {
  if (selection.selectedIds.size === 0) return false;
  if (listedSessionIds.length === 0) return false;
  const allListed = listedSessionIds.every((id) => selection.selectedIds.has(id));
  return allListed ? true : 'indeterminate';
}
