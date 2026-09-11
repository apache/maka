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

/**
 * A marked subset of whatever a surface is currently listing.
 *
 * Ids only, and no opinion about what they identify: the External Session
 * import catalog marks source conversation ids, and anything else with a
 * checkbox column can mark its own.
 *
 * Every function returns the SAME value when nothing changed. Identity is the
 * render boundary for a list of rows, and a fresh Set per keystroke or per poll
 * re-renders all of them for no reason.
 */
export interface ListedSelection {
  readonly selectedIds: ReadonlySet<string>;
}

export const EMPTY_LISTED_SELECTION: ListedSelection = Object.freeze({
  selectedIds: Object.freeze(new Set<string>()) as ReadonlySet<string>,
});

export function toggleListedSelection(
  selection: ListedSelection,
  id: string,
  selected: boolean,
): ListedSelection {
  if (selection.selectedIds.has(id) === selected) return selection;
  const selectedIds = new Set(selection.selectedIds);
  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);
  return { selectedIds };
}

/**
 * The master box: every listed id, or none of them.
 *
 * "All" is what the surface has listed and is showing. A paged catalog does not
 * know its own total, and a filtered one is showing a subset on purpose — a box
 * that reached past the rows beneath it would act on a number nobody saw.
 */
export function setAllListedSelected(
  listedIds: readonly string[],
  selected: boolean,
): ListedSelection {
  return selected ? { selectedIds: new Set(listedIds) } : EMPTY_LISTED_SELECTION;
}

/** What the master box shows: all, none, or some. */
export function listedSelectionMasterState(
  selection: ListedSelection,
  listedIds: readonly string[],
): boolean | 'indeterminate' {
  if (selection.selectedIds.size === 0) return false;
  // `every` over an empty array is vacuously true, which would tick the box
  // above no rows at all.
  if (listedIds.length === 0) return false;
  return listedIds.every((id) => selection.selectedIds.has(id)) ? true : 'indeterminate';
}

/**
 * Drops ids the surface no longer lists.
 *
 * A selection outlives the list it was made from: a search narrows, a filter
 * flips, a poll replaces the window. Keeping an id that is gone would make a
 * count disagree with the rows on screen, and would act on something the user
 * can no longer see.
 */
export function pruneListedSelection(
  selection: ListedSelection,
  listedIds: Iterable<string>,
): ListedSelection {
  const listed = listedIds instanceof Set ? listedIds : new Set(listedIds);
  const selectedIds = new Set<string>();
  for (const id of selection.selectedIds) if (listed.has(id)) selectedIds.add(id);
  if (selectedIds.size === selection.selectedIds.size) return selection;
  return selectedIds.size === 0 ? EMPTY_LISTED_SELECTION : { selectedIds };
}
