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

import { useCallback, useMemo, useReducer } from 'react';
import type { QuoteCompanionPanelState } from './quote-companion-panel-state';

interface SideConversationRecord {
  panel: QuoteCompanionPanelState;
  hasContent: boolean;
  preparing: boolean;
  active: boolean;
}

type SideConversationAction =
  | { type: 'upsert'; panel: QuoteCompanionPanelState; preparingOnCreate: boolean }
  | {
      type: 'update-panel';
      panelId: string;
      update: (panel: QuoteCompanionPanelState) => QuoteCompanionPanelState;
    }
  | { type: 'remove'; panelIds: ReadonlySet<string> }
  | {
      type: 'set-lifecycle';
      panelId: string;
      field: 'hasContent' | 'preparing' | 'active';
      value: boolean;
    };

function reduceSideConversations(
  state: readonly SideConversationRecord[],
  action: SideConversationAction,
): readonly SideConversationRecord[] {
  if (action.type === 'upsert') {
    const index = state.findIndex((record) => record.panel.id === action.panel.id);
    if (index < 0) {
      return [
        ...state,
        {
          panel: action.panel,
          hasContent: false,
          preparing: action.preparingOnCreate,
          active: false,
        },
      ];
    }
    const current = state[index]!;
    if (current.panel === action.panel) return state;
    return state.map((record, recordIndex) =>
      recordIndex === index ? { ...record, panel: action.panel } : record,
    );
  }
  if (action.type === 'update-panel') {
    const index = state.findIndex((record) => record.panel.id === action.panelId);
    if (index < 0) return state;
    const current = state[index]!;
    const panel = action.update(current.panel);
    if (panel === current.panel) return state;
    return state.map((record, recordIndex) =>
      recordIndex === index ? { ...record, panel } : record,
    );
  }
  if (action.type === 'remove') {
    const next = state.filter((record) => !action.panelIds.has(record.panel.id));
    return next.length === state.length ? state : next;
  }
  const index = state.findIndex((record) => record.panel.id === action.panelId);
  if (index < 0 || state[index]![action.field] === action.value) return state;
  return state.map((record, recordIndex) =>
    recordIndex === index ? { ...record, [action.field]: action.value } : record,
  );
}

export function useSideConversationWorkspace() {
  const [records, dispatch] = useReducer(reduceSideConversations, []);
  const panels = useMemo(() => records.map((record) => record.panel), [records]);
  const panelIds = useCallback(
    (field: 'hasContent' | 'preparing' | 'active') =>
      new Set(
        records
          .filter((record) => record[field])
          .map((record) => record.panel.id),
      ),
    [records],
  );
  const contentPanelIds = useMemo(() => panelIds('hasContent'), [panelIds]);
  const preparingPanelIds = useMemo(() => panelIds('preparing'), [panelIds]);
  const activePanelIds = useMemo(() => panelIds('active'), [panelIds]);

  const upsertPanel = useCallback(
    (panel: QuoteCompanionPanelState, preparingOnCreate = false) =>
      dispatch({ type: 'upsert', panel, preparingOnCreate }),
    [],
  );
  const updatePanel = useCallback(
    (
      panelId: string,
      update: (panel: QuoteCompanionPanelState) => QuoteCompanionPanelState,
    ) => dispatch({ type: 'update-panel', panelId, update }),
    [],
  );
  const removePanels = useCallback(
    (panelIds: ReadonlySet<string>) => dispatch({ type: 'remove', panelIds }),
    [],
  );
  const setLifecycle = useCallback(
    (
      panelId: string,
      field: 'hasContent' | 'preparing' | 'active',
      value: boolean,
    ) => dispatch({ type: 'set-lifecycle', panelId, field, value }),
    [],
  );
  const setContent = useCallback(
    (panelId: string, value: boolean) => setLifecycle(panelId, 'hasContent', value),
    [setLifecycle],
  );
  const setPreparing = useCallback(
    (panelId: string, value: boolean) => setLifecycle(panelId, 'preparing', value),
    [setLifecycle],
  );
  const setActive = useCallback(
    (panelId: string, value: boolean) => setLifecycle(panelId, 'active', value),
    [setLifecycle],
  );

  return useMemo(
    () => ({
      panels,
      contentPanelIds,
      preparingPanelIds,
      activePanelIds,
      upsertPanel,
      updatePanel,
      removePanels,
      setContent,
      setPreparing,
      setActive,
    }),
    [
      panels,
      contentPanelIds,
      preparingPanelIds,
      activePanelIds,
      upsertPanel,
      updatePanel,
      removePanels,
      setContent,
      setPreparing,
      setActive,
    ],
  );
}
