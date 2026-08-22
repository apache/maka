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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useResizable } from '@astryxdesign/core/Resizable';
import { readSessionListCollapsed, readSessionListWidth } from './session-list-layout';
import {
  readSessionBottomPanelHeight,
  readSessionBottomPanelOpen,
  readSessionWorkbarCollapsed,
  readSessionWorkbarWidth,
  SESSION_BOTTOM_PANEL_MAX_HEIGHT,
  SESSION_BOTTOM_PANEL_MIN_HEIGHT,
  SESSION_WORKBAR_MAX_WIDTH,
  SESSION_WORKBAR_MIN_WIDTH,
} from './session-workbar-layout';
import {
  activateSessionWorkbarPanelTab,
  closeSessionWorkbarPanelTabs,
  moveSessionWorkbarPanelTab,
  moveSessionWorkbarTabToPanel,
  openSessionWorkbarPanelLauncher,
  openSessionWorkbarPanelTab,
  pinSessionWorkbarPanelTab,
  readSessionWorkbarPanels,
  reorderSessionWorkbarPanelTab,
  titleSessionWorkbarPanelTab,
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
  type SessionWorkbarPlacement,
} from './session-workbar-tabs';

/**
 * Owns the shell layout state (issue #1043): widths, collapse flags and the
 * workbar tab controller, each hydrated from localStorage on first render and
 * persisted by `useAppShellPersistenceEffects`.
 *
 * `useResizable` owns the workbar's clamping and its pointer/keyboard resizing
 * (issue #1861), but not its persistence: `autoSaveId` writes synchronously on
 * every committed size, which is ~90 localStorage writes for one drag. Storage
 * stays on the same debounced effect as the session list, so seeding
 * `defaultSize` from storage is what closes the loop.
 */
export function useShellLayout() {
  const [sessionListWidth, setSessionListWidth] = useState(() => readSessionListWidth());
  const [sessionListCollapsed, setSessionListCollapsed] = useState(() => readSessionListCollapsed());
  const [workbarCollapsed, setWorkbarCollapsed] = useState(() => readSessionWorkbarCollapsed());
  const [bottomPanelOpen, setBottomPanelOpen] = useState(() => readSessionBottomPanelOpen());
  // Read once: useResizable only consumes defaultSize on its first render, and
  // AppShell re-renders on every stream tick.
  const [workbarDefaultWidth] = useState(() => readSessionWorkbarWidth());
  const workbar = useResizable({
    defaultSize: workbarDefaultWidth,
    minSizePx: SESSION_WORKBAR_MIN_WIDTH,
    maxSizePx: SESSION_WORKBAR_MAX_WIDTH,
  });
  const [bottomPanelDefaultHeight] = useState(() => readSessionBottomPanelHeight());
  const bottomPanel = useResizable({
    defaultSize: bottomPanelDefaultHeight,
    minSizePx: SESSION_BOTTOM_PANEL_MIN_HEIGHT,
    maxSizePx: SESSION_BOTTOM_PANEL_MAX_HEIGHT,
  });
  // `_onResizeMove` takes the distance from where the pointer went down, not a
  // per-move increment, so rounding here quantises the drag to whole pixels
  // without accumulating drift. Every other delta the handle sends (arrow keys,
  // Home/End) is already integral. Keeping the hook's own state integral is what
  // lets `aria-valuenow`, the CSS variable and storage agree on one number —
  // rounding at the consumer only fixed the last two.
  const workbarResizable = useMemo(
    () => ({
      ...workbar.props,
      _onResizeMove: (delta: number) => workbar.props._onResizeMove(Math.round(delta)),
    }),
    [workbar.props],
  );
  const bottomPanelResizable = useMemo(
    () => ({
      ...bottomPanel.props,
      _onResizeMove: (delta: number) =>
        bottomPanel.props._onResizeMove(Math.round(delta)),
    }),
    [bottomPanel.props],
  );
  // Astryx ends a drag on pointerup, pointercancel or unmount, but not on focus
  // loss: Cmd+Tab mid-drag and release outside the app leaves the listeners
  // attached and `body` stuck at `cursor: col-resize; user-select: none`. The
  // deleted hand-rolled resize cleaned up on blur; this routes blur back into
  // Astryx's own cancel path rather than re-growing a second teardown.
  useEffect(() => {
    const cancelDrag = () => window.dispatchEvent(new PointerEvent('pointercancel'));
    window.addEventListener('blur', cancelDrag);
    return () => window.removeEventListener('blur', cancelDrag);
  }, []);
  const [workbarPanelsState, setWorkbarPanelsState] = useState(() =>
    readSessionWorkbarPanels(),
  );
  const workbarPanelsStateRef = useRef(workbarPanelsState);
  workbarPanelsStateRef.current = workbarPanelsState;
  const pendingPanelAutoCloseRef = useRef(new Set<SessionWorkbarPlacement>());
  const markPanelForAutoClose = useCallback(
    (placement: SessionWorkbarPlacement, tabIds: readonly string[]) => {
      const closing = new Set(tabIds);
      if (
        workbarPanelsStateRef.current[placement].tabs.some((tab) =>
          closing.has(tab.id),
        )
      ) {
        pendingPanelAutoCloseRef.current.add(placement);
      }
    },
    [],
  );
  const openWorkbarTab = useCallback(
    (
      kind: Exclude<SessionWorkbarTabKind, 'side-chat'>,
      placement: SessionWorkbarPlacement = 'right',
      options: { preview?: boolean } = {},
    ) =>
      setWorkbarPanelsState((current) =>
        openSessionWorkbarPanelTab(current, placement, {
          id: `workbar:${kind}`,
          kind,
          ...(options.preview ? { preview: true } : {}),
        }),
      ),
    [],
  );
  const openDynamicWorkbarTab = useCallback(
    (tab: SessionWorkbarTab, placement: SessionWorkbarPlacement = 'right') =>
      setWorkbarPanelsState((current) =>
        openSessionWorkbarPanelTab(current, placement, tab),
      ),
    [],
  );
  const activateWorkbarTab = useCallback(
    (placement: SessionWorkbarPlacement, tabId: string) =>
      setWorkbarPanelsState((current) =>
        activateSessionWorkbarPanelTab(current, placement, tabId),
      ),
    [],
  );
  const closeWorkbarTab = useCallback(
    (placement: SessionWorkbarPlacement, tabId: string) => {
      markPanelForAutoClose(placement, [tabId]);
      setWorkbarPanelsState((current) =>
        closeSessionWorkbarPanelTabs(current, placement, [tabId]),
      );
    },
    [markPanelForAutoClose],
  );
  const closeWorkbarTabs = useCallback(
    (placement: SessionWorkbarPlacement, tabIds: readonly string[]) => {
      markPanelForAutoClose(placement, tabIds);
      setWorkbarPanelsState((current) =>
        closeSessionWorkbarPanelTabs(current, placement, tabIds),
      );
    },
    [markPanelForAutoClose],
  );
  const reorderWorkbarTab = useCallback(
    (placement: SessionWorkbarPlacement, tabId: string, targetTabId: string) =>
      setWorkbarPanelsState((current) =>
        reorderSessionWorkbarPanelTab(current, placement, tabId, targetTabId),
      ),
    [],
  );
  const moveWorkbarTab = useCallback(
    (
      placement: SessionWorkbarPlacement,
      tabId: string,
      direction: 'left' | 'right',
    ) =>
      setWorkbarPanelsState((current) =>
        moveSessionWorkbarPanelTab(current, placement, tabId, direction),
      ),
    [],
  );
  const openWorkbarLauncher = useCallback(
    (placement: SessionWorkbarPlacement = 'right') =>
      setWorkbarPanelsState((current) =>
        openSessionWorkbarPanelLauncher(current, placement),
      ),
    [],
  );
  const moveWorkbarTabToPanel = useCallback(
    (tabId: string, target: SessionWorkbarPlacement) => {
      setWorkbarPanelsState((current) =>
        moveSessionWorkbarTabToPanel(current, tabId, target),
      );
      if (target === 'right') setWorkbarCollapsed(false);
      else setBottomPanelOpen(true);
    },
    [],
  );
  const titleWorkbarTab = useCallback((tabId: string, title: string) => {
    setWorkbarPanelsState((current) =>
      titleSessionWorkbarPanelTab(current, tabId, title),
    );
  }, []);
  const pinWorkbarTab = useCallback((tabId: string) => {
    setWorkbarPanelsState((current) =>
      pinSessionWorkbarPanelTab(current, tabId),
    );
  }, []);
  useEffect(() => {
    for (const placement of ['right', 'bottom'] as const) {
      if (!pendingPanelAutoCloseRef.current.delete(placement)) continue;
      if (workbarPanelsState[placement].tabs.length > 0) continue;
      if (placement === 'right') setWorkbarCollapsed(true);
      else setBottomPanelOpen(false);
    }
  }, [workbarPanelsState]);
  return {
    sessionListWidth,
    setSessionListWidth,
    sessionListCollapsed,
    setSessionListCollapsed,
    workbarCollapsed,
    setWorkbarCollapsed,
    bottomPanelOpen,
    setBottomPanelOpen,
    workbarWidth: workbar.size,
    workbarResizable,
    bottomPanelHeight: bottomPanel.size,
    bottomPanelResizable,
    workbarPanelsState,
    openWorkbarTab,
    openDynamicWorkbarTab,
    activateWorkbarTab,
    closeWorkbarTab,
    closeWorkbarTabs,
    reorderWorkbarTab,
    moveWorkbarTab,
    moveWorkbarTabToPanel,
    titleWorkbarTab,
    pinWorkbarTab,
    openWorkbarLauncher,
  };
}
