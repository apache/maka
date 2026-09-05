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
  safeLocalStorageGet,
  safeLocalStorageSet,
} from '../../../browser-storage.js';
import {
  persistableSessionWorkbarPanels,
  readSessionWorkbarPanels,
  reduceWorkbarPanels,
  type SessionWorkbarPanelsState,
  type WorkbarPanelsAction,
} from './workbar-tabs.js';

/**
 * 480 rather than the original 400: the trace tab's overview is a two-column
 * data grid, and at 400 its figures had to be squeezed against their labels
 * before the qualifier column had room. The stored width still wins, so only
 * a reader who never dragged the handle sees the change.
 */
export const SESSION_WORKBAR_DEFAULT_WIDTH = 480;
/**
 * 340 is the floor `astryx docs layout` gives a detail/inspector panel, and it
 * is also where the strip stops fitting: five faces need 386px of tab and have
 * 260px, so below this the strip is always scrolling.
 */
export const SESSION_WORKBAR_MIN_WIDTH = 340;
export const SESSION_WORKBAR_MAX_WIDTH = 600;
export const SESSION_BOTTOM_PANEL_DEFAULT_HEIGHT = 300;
export const SESSION_BOTTOM_PANEL_MIN_HEIGHT = 180;
export const SESSION_BOTTOM_PANEL_MAX_HEIGHT = 520;

export interface WorkbarLayoutState {
  panels: SessionWorkbarPanelsState;
  rightCollapsed: boolean;
  bottomOpen: boolean;
  rightWidth: number;
  bottomHeight: number;
}

export type WorkbarLayoutAction =
  | WorkbarPanelsAction
  | {
      type: 'collapse';
      placement: 'right' | 'bottom';
      collapsed: boolean;
    }
  | {
      type: 'resize';
      placement: 'right' | 'bottom';
      size: number;
    };

export type WorkbarLayoutPersistenceTarget =
  | 'all'
  | 'topology'
  | 'right-visibility'
  | 'bottom-visibility'
  | 'right-size'
  | 'bottom-size';

function clampSize(size: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(size)));
}

/**
 * Reads the persisted width without applying bounds. `loadWorkbarLayout`
 * applies the shared reducer policy so hydration and resize actions use one
 * clamping rule.
 */
export function readSessionWorkbarWidth(): number {
  const stored = Number(safeLocalStorageGet('maka-session-workbar-width-v1'));
  return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : SESSION_WORKBAR_DEFAULT_WIDTH;
}

export function readSessionWorkbarCollapsed(): boolean {
  const stored = safeLocalStorageGet('maka-session-workbar-collapsed-v1');
  if (stored === 'false') return false;
  if (stored === 'true') return true;
  return true;
}

export function readSessionBottomPanelHeight(): number {
  const stored = Number(safeLocalStorageGet('maka-session-bottom-panel-height-v1'));
  return Number.isFinite(stored) && stored > 0
    ? Math.round(stored)
    : SESSION_BOTTOM_PANEL_DEFAULT_HEIGHT;
}

export function readSessionBottomPanelOpen(): boolean {
  return safeLocalStorageGet('maka-session-bottom-panel-open-v1') === 'true';
}

export function loadWorkbarLayout(): WorkbarLayoutState {
  return {
    panels: readSessionWorkbarPanels(),
    rightCollapsed: readSessionWorkbarCollapsed(),
    bottomOpen: readSessionBottomPanelOpen(),
    rightWidth: clampSize(
      readSessionWorkbarWidth(),
      SESSION_WORKBAR_MIN_WIDTH,
      SESSION_WORKBAR_MAX_WIDTH,
    ),
    bottomHeight: clampSize(
      readSessionBottomPanelHeight(),
      SESSION_BOTTOM_PANEL_MIN_HEIGHT,
      SESSION_BOTTOM_PANEL_MAX_HEIGHT,
    ),
  };
}

export function persistWorkbarLayout(
  state: WorkbarLayoutState,
  target: WorkbarLayoutPersistenceTarget = 'all',
): void {
  if (target === 'all' || target === 'topology') {
    safeLocalStorageSet(
      'maka-session-workbar-panels-v3',
      JSON.stringify(persistableSessionWorkbarPanels(state.panels)),
    );
  }
  if (target === 'all' || target === 'right-visibility') {
    safeLocalStorageSet(
      'maka-session-workbar-collapsed-v1',
      state.rightCollapsed ? 'true' : 'false',
    );
  }
  if (target === 'all' || target === 'bottom-visibility') {
    safeLocalStorageSet(
      'maka-session-bottom-panel-open-v1',
      state.bottomOpen ? 'true' : 'false',
    );
  }
  if (target === 'all' || target === 'right-size') {
    safeLocalStorageSet(
      'maka-session-workbar-width-v1',
      String(state.rightWidth),
    );
  }
  if (target === 'all' || target === 'bottom-size') {
    safeLocalStorageSet(
      'maka-session-bottom-panel-height-v1',
      String(state.bottomHeight),
    );
  }
}

export function reduceWorkbarLayout(
  state: WorkbarLayoutState,
  action: WorkbarLayoutAction,
): WorkbarLayoutState {
  if (action.type === 'collapse') {
    if (action.placement === 'right') {
      return state.rightCollapsed === action.collapsed
        ? state
        : { ...state, rightCollapsed: action.collapsed };
    }
    const bottomOpen = !action.collapsed;
    return state.bottomOpen === bottomOpen
      ? state
      : { ...state, bottomOpen };
  }
  if (action.type === 'resize') {
    if (action.placement === 'right') {
      const rightWidth = clampSize(
        action.size,
        SESSION_WORKBAR_MIN_WIDTH,
        SESSION_WORKBAR_MAX_WIDTH,
      );
      return state.rightWidth === rightWidth
        ? state
        : { ...state, rightWidth };
    }
    const bottomHeight = clampSize(
      action.size,
      SESSION_BOTTOM_PANEL_MIN_HEIGHT,
      SESSION_BOTTOM_PANEL_MAX_HEIGHT,
    );
    return state.bottomHeight === bottomHeight
      ? state
      : { ...state, bottomHeight };
  }

  const panels = reduceWorkbarPanels(state.panels, action);
  if (panels === state.panels) return state;
  let rightCollapsed = state.rightCollapsed;
  let bottomOpen = state.bottomOpen;
  if (action.type === 'open' || action.type === 'open-launcher') {
    if (action.placement === 'right') rightCollapsed = false;
    else bottomOpen = true;
  } else if (action.type === 'move-to-panel') {
    if (action.target === 'right') rightCollapsed = false;
    else bottomOpen = true;
  } else if (action.type === 'close') {
    if (
      state.panels[action.placement].tabs.length > 0 &&
      panels[action.placement].tabs.length === 0
    ) {
      if (action.placement === 'right') rightCollapsed = true;
      else bottomOpen = false;
    }
  }
  return { ...state, panels, rightCollapsed, bottomOpen };
}
