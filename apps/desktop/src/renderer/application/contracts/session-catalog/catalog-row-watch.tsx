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

import { useEffect, useEffectEvent, useMemo } from 'react';
import type { DesktopSessionSummary } from '../../../../shared/desktop-session-projection.js';

export type { DesktopSessionSummary };
import { useExternalStoreSelector } from './use-external-store-selector.js';
import {
  selectSessionById,
  type SessionCatalogController,
  type SessionCatalogState,
} from './session-catalog-state.js';

const selectRows = (
  state: SessionCatalogState,
  ids: readonly (string | undefined)[],
): (DesktopSessionSummary | undefined)[] =>
  ids.map((id) => selectSessionById(state, id));

function rowsEqual(
  a: readonly (DesktopSessionSummary | undefined)[],
  b: readonly (DesktopSessionSummary | undefined)[],
): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
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
  onRows: (rows: readonly (DesktopSessionSummary | undefined)[]) => void;
}) {
  const onRows = useEffectEvent(props.onRows);
  // The caller passes an inline array; the selector memo is keyed on the arg,
  // so the ids need a stable identity across renders that do not change them.
  const idsKey = (props.sessionIds ?? EMPTY_IDS).join('\0');
  const ids = useMemo(() => idsKey.split('\0').map((id) => id || undefined), [idsKey]);
  const rows = useExternalStoreSelector(
    props.catalog,
    selectRows,
    ids,
    rowsEqual,
  );
  useEffect(() => onRows(rows), [rows, onRows]);
  return null;
}
