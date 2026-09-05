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

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type SetStateAction,
} from 'react';
import type { ResizableProps } from '@astryxdesign/core/Resizable';
import {
  loadWorkbarLayout,
  persistWorkbarLayout,
  reduceWorkbarLayout,
  SESSION_BOTTOM_PANEL_MAX_HEIGHT,
  SESSION_BOTTOM_PANEL_MIN_HEIGHT,
  SESSION_WORKBAR_MAX_WIDTH,
  SESSION_WORKBAR_MIN_WIDTH,
} from '../model/workbar-layout.js';
import {
  type SessionWorkbarPlacement,
  type SessionWorkbarTab,
  type SessionWorkbarTabKind,
} from '../model/workbar-tabs.js';

const LAYOUT_PERSIST_DEBOUNCE_MS = 200;

/**
 * Owns the application-level Workbar topology, dimensions and persistence.
 * Session-owned panel data deliberately lives below this boundary.
 */
export function useWorkbarLayoutState() {
  const [state, dispatch] = useReducer(
    reduceWorkbarLayout,
    undefined,
    loadWorkbarLayout,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const rightDragStartRef = useRef(state.rightWidth);
  const bottomDragStartRef = useRef(state.bottomHeight);
  // The Workbar reducer is the controlled size authority. These props adapt it
  // to Astryx's ResizeHandle contract without introducing useResizable state;
  // snapping and handle-driven collapse are deliberately disabled here.
  const workbarResizable = useMemo<ResizableProps>(
    () => ({
      _size: state.rightWidth,
      _isCollapsed: false,
      _onResizeStart: () => {
        rightDragStartRef.current = state.rightWidth;
      },
      _onResizeMove: (delta) =>
        dispatch({
          type: 'resize',
          placement: 'right',
          size: rightDragStartRef.current + Math.round(delta),
        }),
      _onResizeEnd: () => undefined,
      _minSizePx: SESSION_WORKBAR_MIN_WIDTH,
      _maxSizePx: SESSION_WORKBAR_MAX_WIDTH,
      _snaps: [],
      _collapsedSize: 40,
      _collapsible: false,
      _isResizableProps: true,
    }),
    [state.rightWidth],
  );
  const bottomPanelResizable = useMemo<ResizableProps>(
    () => ({
      _size: state.bottomHeight,
      _isCollapsed: false,
      _onResizeStart: () => {
        bottomDragStartRef.current = state.bottomHeight;
      },
      _onResizeMove: (delta) =>
        dispatch({
          type: 'resize',
          placement: 'bottom',
          size: bottomDragStartRef.current + Math.round(delta),
        }),
      _onResizeEnd: () => undefined,
      _minSizePx: SESSION_BOTTOM_PANEL_MIN_HEIGHT,
      _maxSizePx: SESSION_BOTTOM_PANEL_MAX_HEIGHT,
      _snaps: [],
      _collapsedSize: 40,
      _collapsible: false,
      _isResizableProps: true,
    }),
    [state.bottomHeight],
  );

  useEffect(() => {
    const cancelDrag = () =>
      window.dispatchEvent(new PointerEvent('pointercancel'));
    window.addEventListener('blur', cancelDrag);
    return () => window.removeEventListener('blur', cancelDrag);
  }, []);

  const openWorkbarTab = useCallback(
    (
      kind: Exclude<SessionWorkbarTabKind, 'side-chat'>,
      placement: SessionWorkbarPlacement = 'right',
    ) => dispatch({ type: 'open', placement, tab: { id: `workbar:${kind}`, kind } }),
    [],
  );
  const openDynamicWorkbarTab = useCallback(
    (tab: SessionWorkbarTab, placement: SessionWorkbarPlacement = 'right') =>
      dispatch({ type: 'open', placement, tab }),
    [],
  );
  const activateWorkbarTab = useCallback(
    (placement: SessionWorkbarPlacement, tabId: string) =>
      dispatch({ type: 'activate', placement, tabId }),
    [],
  );
  const closeWorkbarTab = useCallback(
    (placement: SessionWorkbarPlacement, tabId: string) =>
      dispatch({ type: 'close', placement, tabIds: [tabId] }),
    [],
  );
  const closeWorkbarTabs = useCallback(
    (placement: SessionWorkbarPlacement, tabIds: readonly string[]) =>
      dispatch({ type: 'close', placement, tabIds }),
    [],
  );
  const openWorkbarLauncher = useCallback(
    (placement: SessionWorkbarPlacement = 'right') =>
      dispatch({ type: 'open-launcher', placement }),
    [],
  );
  const moveWorkbarTabToPanel = useCallback(
    (tabId: string, target: SessionWorkbarPlacement) =>
      dispatch({ type: 'move-to-panel', tabId, target }),
    [],
  );
  const titleWorkbarTab = useCallback((tabId: string, title: string) => {
    dispatch({ type: 'title', tabId, title });
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      persistWorkbarLayout(stateRef.current, 'right-size');
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [state.rightWidth]);
  useEffect(() => {
    persistWorkbarLayout(stateRef.current, 'right-visibility');
  }, [state.rightCollapsed]);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      persistWorkbarLayout(stateRef.current, 'bottom-size');
    }, LAYOUT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [state.bottomHeight]);
  useEffect(() => {
    persistWorkbarLayout(stateRef.current, 'bottom-visibility');
  }, [state.bottomOpen]);
  useEffect(() => {
    persistWorkbarLayout(stateRef.current, 'topology');
  }, [state.panels]);

  const setWorkbarCollapsed = useCallback(
    (next: SetStateAction<boolean>) => {
      const collapsed =
        typeof next === 'function'
          ? next(stateRef.current.rightCollapsed)
          : next;
      dispatch({ type: 'collapse', placement: 'right', collapsed });
    },
    [],
  );
  const setBottomPanelOpen = useCallback(
    (next: SetStateAction<boolean>) => {
      const open =
        typeof next === 'function' ? next(stateRef.current.bottomOpen) : next;
      dispatch({
        type: 'collapse',
        placement: 'bottom',
        collapsed: !open,
      });
    },
    [],
  );

  return {
    workbarCollapsed: state.rightCollapsed,
    setWorkbarCollapsed,
    bottomPanelOpen: state.bottomOpen,
    setBottomPanelOpen,
    workbarWidth: state.rightWidth,
    workbarResizable,
    bottomPanelHeight: state.bottomHeight,
    bottomPanelResizable,
    workbarPanelsState: state.panels,
    openWorkbarTab,
    openDynamicWorkbarTab,
    activateWorkbarTab,
    closeWorkbarTab,
    closeWorkbarTabs,
    moveWorkbarTabToPanel,
    titleWorkbarTab,
    openWorkbarLauncher,
  };
}
