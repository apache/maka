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

import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import type { DesktopSessionSummary } from '../../../../shared/desktop-session-projection.js';

export type { DesktopSessionSummary };
import { useExternalStoreSelector } from './use-external-store-selector.js';
import {
  selectSessionById,
  type SessionCatalogController,
  type SessionCatalogState,
} from './session-catalog-state.js';

/** What the catalog can currently prove about a watched id. */
export interface ObservedCatalogRow {
  readonly summary: DesktopSessionSummary | undefined;
  /** A targeted read answered "gone" — authoritative absence, not admission lag. */
  readonly removed: boolean;
}

export interface CatalogWatchedRow {
  readonly summary: DesktopSessionSummary | undefined;
  /**
   * No row yet and neither an observation nor a removal covers this id — the
   * catalog simply has not caught up. Absence here is not evidence of removal.
   */
  readonly pending: boolean;
}

export const selectWatchedCatalogRows = (
  state: SessionCatalogState,
  ids: readonly (string | undefined)[],
): ObservedCatalogRow[] =>
  ids.map((id) => ({
    summary: selectSessionById(state, id),
    removed: id !== undefined && state.removedIds.has(id),
  }));

function observedRowsEqual(
  a: readonly ObservedCatalogRow[],
  b: readonly ObservedCatalogRow[],
): boolean {
  return a.length === b.length
    && a.every((row, index) => row.summary === b[index].summary && row.removed === b[index].removed);
}

/**
 * Resolve an emitted observation against the ids this watch has already seen.
 * Marks each id that produced a row — so an id whose row later disappears is
 * a removal, while one that was never observed stays pending: created-but-not-
 * yet-admitted is the edit-and-resend window, not a deletion.
 */
export function annotateWatchedRows(
  observed: readonly ObservedCatalogRow[],
  ids: readonly (string | undefined)[],
  seen: Set<string>,
): CatalogWatchedRow[] {
  return ids.map((id, index) => {
    const { summary, removed } = observed[index] ?? { summary: undefined, removed: false };
    if (id !== undefined && summary !== undefined) seen.add(id);
    return {
      summary,
      pending: id !== undefined && summary === undefined && !removed && !seen.has(id),
    };
  });
}

/** Every watched row is present and usable, or still pending its first observation. */
export function catalogWatchedRowsUsable(rows: readonly CatalogWatchedRow[]): boolean {
  return rows.every(
    (row) => row.pending || (row.summary !== undefined && !row.summary.isArchived),
  );
}

const EMPTY_IDS: readonly (string | undefined)[] = [];

/**
 * Renderless catalog-row subscription for a legacy consumer that cannot own a
 * hook of its own: mounts inside the tree, selects the rows for `sessionIds`,
 * and reports them to `onRows` whenever the selection actually changes.
 */
export function CatalogRowWatch(props: {
  catalog: SessionCatalogController;
  sessionIds: readonly (string | undefined)[] | undefined;
  onRows: (rows: readonly CatalogWatchedRow[]) => void;
}) {
  const onRows = useEffectEvent(props.onRows);
  // The caller passes an inline array; the selector memo is keyed on the arg,
  // so the ids need a stable identity across renders that do not change them.
  const idsKey = (props.sessionIds ?? EMPTY_IDS).join('\0');
  const ids = useMemo(() => idsKey.split('\0').map((id) => id || undefined), [idsKey]);
  const observed = useExternalStoreSelector(
    props.catalog,
    selectWatchedCatalogRows,
    ids,
    observedRowsEqual,
  );
  // `seen` lives in an effect, not the selector: a snapshot can be read on a
  // render React discards, and only rows actually reported count as observed.
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(
    () => onRows(annotateWatchedRows(observed, ids, seenRef.current)),
    [observed, ids, onRows],
  );
  return null;
}
