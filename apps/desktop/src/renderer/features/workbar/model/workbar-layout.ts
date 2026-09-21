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
  parseSessionWorkbarPanels,
  reduceWorkbarPanels,
  type SessionWorkbarPanelsState,
  type SessionWorkbarPlacement,
  type WorkbarPanelsAction,
  type SessionWorkbarTab,
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
/**
 * The conversation column the rail leaves behind on a window wide enough for
 * both. That is why the ceiling is a layout measurement (`container − gap −
 * this`) rather than a constant. A window too narrow for both keeps the rail's
 * floor and lets the conversation go below this target; the stacked layout
 * below the shell's narrow-window breakpoint owns that band.
 */
export const SESSION_CONVERSATION_MIN_WIDTH = 480;
export const SESSION_BOTTOM_PANEL_DEFAULT_HEIGHT = 300;
export const SESSION_BOTTOM_PANEL_MIN_HEIGHT = 180;
export const SESSION_BOTTOM_PANEL_MAX_HEIGHT = 520;

export interface WorkbarLayoutState {
  panels: SessionWorkbarPanelsState;
  activeSessionId: string | undefined;
  collapsedBySession: Record<string, boolean>;
  bottomOpen: boolean;
  /**
   * The width the user last chose, persisted as-is. A narrow window holds the
   * *display* width (`sessionWorkbarDisplayWidth`) back instead of overwriting
   * this, so widening the window gives the width back.
   */
  rightWidthPreference: number;
  /**
   * The measured ceiling, `undefined` until the layout container reports one.
   * `measure-right-ceiling` is its only writer: the policy lives in the reducer,
   * the measurement in the hook that observes the element.
   */
  rightWidthCeiling: number | undefined;
  bottomHeight: number;
}

export type WorkbarLayoutAction =
  | WorkbarPanelsAction
  | { type: 'restore-terminals'; tabs: readonly SessionWorkbarTab[] }
  | { type: 'close-terminal'; sessionId: string; ref: string }
  | {
      type: 'remove-stale';
      placement: SessionWorkbarPlacement;
      tabIds: readonly string[];
    }
  | { type: 'activate-session'; sessionId: string | undefined }
  | { type: 'retain-sessions'; sessionIds: ReadonlySet<string> }
  | {
      type: 'collapse';
      placement: 'right' | 'bottom';
      collapsed: boolean;
    }
  | {
      type: 'resize';
      placement: 'right' | 'bottom';
      size: number;
    }
  | { type: 'measure-right-ceiling'; ceiling: number };

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
 * The ceiling the rail may display at. Unmeasured there is no bound to trust,
 * and the default — not the stored preference — is the safe one: a stale wide
 * value must not overrun the conversation column on the first frame.
 */
export function sessionWorkbarMaxWidth(state: WorkbarLayoutState): number {
  return state.rightWidthCeiling ?? SESSION_WORKBAR_DEFAULT_WIDTH;
}

/**
 * How wide the rail actually renders. The ceiling moves with the window, so
 * readers that ask "how wide is the rail" want this; the preference is only
 * what a drag writes and what storage keeps.
 */
export function sessionWorkbarDisplayWidth(state: WorkbarLayoutState): number {
  return clampSize(
    state.rightWidthPreference,
    SESSION_WORKBAR_MIN_WIDTH,
    sessionWorkbarMaxWidth(state),
  );
}

/**
 * The ceiling a container grants the rail, where `gap` is the spacing between
 * the two columns: what is left once the conversation keeps its
 * `SESSION_CONVERSATION_MIN_WIDTH` target. A container too small for both
 * returns below the rail's floor on purpose — the reducer owns the floor, so
 * the caller can still see that the space ran out.
 */
export function sessionWorkbarCeiling(containerWidth: number, gap: number): number {
  return containerWidth - gap - SESSION_CONVERSATION_MIN_WIDTH;
}

/**
 * Reads the persisted width without applying bounds. `loadWorkbarLayout` keeps
 * it unclamped because the container, not a constant, decides how wide the rail
 * may display, and a window that is too narrow right now must not truncate the
 * preference the next window would fit.
 */
export function readSessionWorkbarWidth(): number {
  const stored = Number(safeLocalStorageGet('maka-session-workbar-width-v1'));
  return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : SESSION_WORKBAR_DEFAULT_WIDTH;
}

const SESSION_COLLAPSE_KEY = 'maka-session-workbar-collapsed-v2';

function readSessionWorkbarCollapsed(): Record<string, boolean> {
  try {
    const stored: unknown = JSON.parse(safeLocalStorageGet(SESSION_COLLAPSE_KEY) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([, value]) => typeof value === 'boolean'),
    );
  } catch {
    return {};
  }
}

export function isSessionWorkbarCollapsed(state: WorkbarLayoutState): boolean {
  const id = state.activeSessionId;
  return id !== undefined && Object.hasOwn(state.collapsedBySession, id)
    ? state.collapsedBySession[id]!
    : true;
}

function withRightCollapsed(state: WorkbarLayoutState, collapsed: boolean): WorkbarLayoutState {
  const id = state.activeSessionId;
  if (id === undefined || isSessionWorkbarCollapsed(state) === collapsed) return state;
  return { ...state, collapsedBySession: { ...state.collapsedBySession, [id]: collapsed } };
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

export function loadWorkbarLayout(activeSessionId?: string): WorkbarLayoutState {
  return {
    panels: parseSessionWorkbarPanels(safeLocalStorageGet('maka-session-workbar-panels-v3')),
    activeSessionId,
    collapsedBySession: readSessionWorkbarCollapsed(),
    bottomOpen: readSessionBottomPanelOpen(),
    rightWidthPreference: readSessionWorkbarWidth(),
    rightWidthCeiling: undefined,
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
      SESSION_COLLAPSE_KEY,
      JSON.stringify(state.collapsedBySession),
    );
    // The old global preference has no Session owner and cannot be migrated
    // without giving an unrelated conversation its expanded state.
    try {
      localStorage.removeItem('maka-session-workbar-collapsed-v1');
    } catch {
      // Storage may be unavailable in restricted renderer contexts.
    }
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
      String(state.rightWidthPreference),
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
  if (action.type === 'close-terminal') {
    for (const placement of ['right', 'bottom'] as const) {
      const tabIds = state.panels[placement].tabs.filter((tab) =>
        tab.kind === 'terminal' && tab.ownerSessionId === action.sessionId && tab.resourceRef === action.ref,
      ).map((tab) => tab.id);
      if (tabIds.length) state = reduceWorkbarLayout(state, {
        type: state.activeSessionId === action.sessionId ? 'close' : 'remove-stale', placement, tabIds,
      });
    }
    return state;
  }
  if (action.type === 'restore-terminals') {
    const existing = new Set([...state.panels.right.tabs, ...state.panels.bottom.tabs].map((tab) => tab.id));
    const missing = action.tabs.filter((tab) => !existing.has(tab.id));
    if (!missing.length) return state;
    const right = state.panels.right;
    return { ...state, panels: { ...state.panels, right: {
      ...right,
      tabs: [...right.tabs, ...missing],
      activeTabId: right.activeTabId ?? missing[0]!.id,
      launcherOpen: right.tabs.length === 0 ? false : right.launcherOpen,
    } } };
  }
  if (action.type === 'activate-session') {
    return state.activeSessionId === action.sessionId
      ? state
      : { ...state, activeSessionId: action.sessionId };
  }
  if (action.type === 'measure-right-ceiling') {
    // A container narrower than the rail's floor still reports the floor: the
    // stacked layout takes over below the shell's narrow-window breakpoint, and
    // until it does the rail keeps its minimum rather than collapsing further.
    if (!Number.isFinite(action.ceiling)) return state;
    const ceiling = Math.max(SESSION_WORKBAR_MIN_WIDTH, Math.round(action.ceiling));
    return state.rightWidthCeiling === ceiling
      ? state
      : { ...state, rightWidthCeiling: ceiling };
  }
  if (action.type === 'retain-sessions') {
    let panels = state.panels;
    for (const placement of ['right', 'bottom'] as const) {
      const tabIds = panels[placement].tabs.filter((tab) =>
        tab.kind === 'terminal' && tab.ownerSessionId && !action.sessionIds.has(tab.ownerSessionId),
      ).map((tab) => tab.id);
      if (tabIds.length) panels = reduceWorkbarPanels(panels, { type: 'close', placement, tabIds });
    }
    const entries = Object.entries(state.collapsedBySession).filter(
      ([id]) => id === state.activeSessionId || action.sessionIds.has(id),
    );
    return panels === state.panels && entries.length === Object.keys(state.collapsedBySession).length
      ? state
      : { ...state, panels, collapsedBySession: Object.fromEntries(entries) };
  }
  if (action.type === 'collapse') {
    if (action.placement === 'right') {
      return withRightCollapsed(state, action.collapsed);
    }
    const bottomOpen = !action.collapsed;
    return state.bottomOpen === bottomOpen
      ? state
      : { ...state, bottomOpen };
  }
  if (action.type === 'resize') {
    if (action.placement === 'right') {
      // A drag is the user's new preference, inside the space the container has.
      // Its start is the *displayed* width, so a narrowed window still drags
      // from what the user can see.
      const rightWidthPreference = clampSize(
        action.size,
        SESSION_WORKBAR_MIN_WIDTH,
        sessionWorkbarMaxWidth(state),
      );
      return state.rightWidthPreference === rightWidthPreference
        ? state
        : { ...state, rightWidthPreference };
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

  const panels = reduceWorkbarPanels(
    state.panels,
    action.type === 'remove-stale'
      ? { type: 'close', placement: action.placement, tabIds: action.tabIds }
      : action,
  );
  if (panels === state.panels) return state;
  // A resource may finish opening after navigation. It belongs to the request's
  // Session and must not reveal a panel in whichever Session is now selected.
  if (action.type === 'open' && action.tab.ownerSessionId &&
    action.tab.ownerSessionId !== state.activeSessionId) {
    return { ...state, panels,
      ...(action.placement === 'right' ? {
        collapsedBySession: { ...state.collapsedBySession, [action.tab.ownerSessionId]: false },
      } : {}),
    };
  }
  let rightCollapsed = isSessionWorkbarCollapsed(state);
  let bottomOpen = state.bottomOpen;
  if (action.type === 'open' || action.type === 'open-launcher') {
    if (action.placement === 'right') rightCollapsed = false;
    else bottomOpen = true;
  } else if (action.type === 'move-to-panel') {
    if (action.target === 'right') rightCollapsed = false;
    else bottomOpen = true;
  } else if (
    action.type === 'close' ||
    (action.type === 'remove-stale' && action.placement === 'bottom')
  ) {
    if (
      state.panels[action.placement].tabs.length > 0 &&
      panels[action.placement].tabs.length === 0
    ) {
      if (action.placement === 'right') rightCollapsed = true;
      else bottomOpen = false;
    }
  }
  return withRightCollapsed({ ...state, panels, bottomOpen }, rightCollapsed);
}
