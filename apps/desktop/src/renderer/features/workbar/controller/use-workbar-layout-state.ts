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
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { ResizableProps } from '@astryxdesign/core/Resizable';
import {
  loadWorkbarLayout,
  isSessionWorkbarCollapsed,
  persistWorkbarLayout,
  reduceWorkbarLayout,
  sessionWorkbarCeiling,
  sessionWorkbarDisplayWidth,
  sessionWorkbarMaxWidth,
  SESSION_BOTTOM_PANEL_MAX_HEIGHT,
  SESSION_BOTTOM_PANEL_MIN_HEIGHT,
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
 * Right-panel visibility belongs to each Session; topology and sizes stay global.
 *
 * `layoutContainerRef` is the grid holding both the conversation column and the
 * rail; `layoutGap` is the spacing between them. Measuring one and knowing the
 * other is what makes the rail's ceiling a function of the available space.
 */
export function useWorkbarLayoutState(
  activeSessionId: string | undefined,
  authoritativeSessionIds: ReadonlySet<string> | undefined,
  layoutContainerRef?: RefObject<HTMLElement | null>,
  layoutGap = 0,
) {
  const [state, dispatch] = useReducer(
    reduceWorkbarLayout,
    activeSessionId,
    loadWorkbarLayout,
  );
  // Bind the owner before this render commits. An effect-based mirror would
  // briefly show the previous Session's panel and could overwrite an open
  // action issued by another layout effect in the activation commit.
  if (state.activeSessionId !== activeSessionId) {
    dispatch({ type: 'activate-session', sessionId: activeSessionId });
  }
  useEffect(() => {
    if (authoritativeSessionIds) {
      dispatch({ type: 'retain-sessions', sessionIds: authoritativeSessionIds });
    }
  }, [authoritativeSessionIds, activeSessionId, state.panels]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const rightWidth = sessionWorkbarDisplayWidth(state);
  const rightWidthMax = sessionWorkbarMaxWidth(state);
  const rightDragStartRef = useRef(rightWidth);
  const bottomDragStartRef = useRef(state.bottomHeight);
  // The measured input to the width policy. Observed is the parent grid, never a
  // child whose width the ceiling sets — that would feed the measurement back
  // into its own result. The synchronous pass matters as much as the observer: it
  // lands in this commit, so the first painted frame already has the ceiling.
  useLayoutEffect(() => {
    const container = layoutContainerRef?.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const available = container.getBoundingClientRect().width;
      if (available <= 0) return;
      dispatch({
        type: 'measure-right-ceiling',
        ceiling: sessionWorkbarCeiling(available, layoutGap),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [layoutContainerRef, layoutGap]);
  // The Workbar reducer is the controlled size authority. These props adapt it
  // to Astryx's ResizeHandle contract without introducing useResizable state;
  // snapping and handle-driven collapse are deliberately disabled here.
  const workbarResizable = useMemo<ResizableProps>(
    () => ({
      _size: rightWidth,
      _isCollapsed: false,
      _onResizeStart: () => {
        rightDragStartRef.current = rightWidth;
      },
      _onResizeMove: (delta) =>
        dispatch({
          type: 'resize',
          placement: 'right',
          size: rightDragStartRef.current + Math.round(delta),
        }),
      _onResizeEnd: () => undefined,
      _minSizePx: SESSION_WORKBAR_MIN_WIDTH,
      // The handle and the reducer hold the same ceiling, so the drag stops
      // where the state machine would stop it instead of snapping back.
      _maxSizePx: rightWidthMax,
      _snaps: [],
      _collapsedSize: 40,
      _collapsible: false,
      _isResizableProps: true,
    }),
    [rightWidth, rightWidthMax],
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
  const restoreTerminals = useCallback(
    (tabs: readonly SessionWorkbarTab[]) => dispatch({ type: 'restore-terminals', tabs }),
    [],
  );
  const closeTerminal = useCallback(
    (sessionId: string, ref: string) => dispatch({ type: 'close-terminal', sessionId, ref }),
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
    (
      placement: SessionWorkbarPlacement,
      tabIds: readonly string[],
      options?: { preserveVisibility?: boolean },
    ) =>
      dispatch({
        type: options?.preserveVisibility ? 'remove-stale' : 'close',
        placement,
        tabIds,
      }),
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
  // Only the preference is persisted: a ceiling that narrowed the display is a
  // property of this window, not of what the user asked for.
  }, [state.rightWidthPreference]);
  useEffect(() => {
    persistWorkbarLayout(stateRef.current, 'right-visibility');
  }, [state.collapsedBySession]);
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
          ? next(isSessionWorkbarCollapsed(stateRef.current))
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
    workbarCollapsed: isSessionWorkbarCollapsed(state),
    setWorkbarCollapsed,
    bottomPanelOpen: state.bottomOpen,
    setBottomPanelOpen,
    // What the frame publishes to CSS is the width the rail displays at, not
    // the stored preference the ceiling holds back.
    workbarWidth: rightWidth,
    workbarResizable,
    bottomPanelHeight: state.bottomHeight,
    bottomPanelResizable,
    workbarPanelsState: state.panels,
    openWorkbarTab,
    openDynamicWorkbarTab,
    restoreTerminals,
    activateWorkbarTab,
    closeWorkbarTab,
    closeWorkbarTabs,
    closeTerminal,
    moveWorkbarTabToPanel,
    titleWorkbarTab,
    openWorkbarLauncher,
  };
}
