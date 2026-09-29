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
import { SHELL_CONVERSATION_MIN_WIDTH_PX } from '../../../application/contracts/shell-layout-contract.js';
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
 * 340 is the normal drag minimum `astryx docs layout` gives a detail/inspector
 * panel. A compact window can force the rendered panel below it while keeping
 * the saved preference; there is no adjustable drag range in that case.
 */
export const SESSION_WORKBAR_MIN_WIDTH = 340;
/**
 * The conversation column the rail leaves behind on a window wide enough for
 * both. That is why the ceiling is a layout measurement (`container − gap −
 * this`) rather than a constant. This matches the shell's CSS token, including
 * windows where the Workbar has less than its usual 340px minimum available.
 */
export const SESSION_CONVERSATION_MIN_WIDTH = SHELL_CONVERSATION_MIN_WIDTH_PX;
export const SESSION_BOTTOM_PANEL_DEFAULT_HEIGHT = 300;
export const SESSION_BOTTOM_PANEL_MIN_HEIGHT = 180;
export const SESSION_BOTTOM_PANEL_MAX_HEIGHT = 520;

export interface WorkbarLayoutState {
  panels: SessionWorkbarPanelsState;
  activeSessionId: string | undefined;
  /** The stored per-Session preference. Readers want `isSessionWorkbarCollapsed`. */
  collapsedBySession: Record<string, boolean>;
  /** A compact window hides every Workbar except the ones the user toggled
      while it was compact, which this records by their chosen collapsed state.
      Never persisted on its own: promoted into `collapsedBySession` when the
      spell ends. */
  compact: boolean;
  compactCollapsed: Record<string, boolean>;
  /** The expanded rail took the Workbar's grid room, so it was suppressed.
      A space decision like the rail's `spaceConcealed` — never a user choice,
      never persisted — released when the room returns or the spell ends, and
      cleared by any explicit collapse/expand the user makes. */
  spaceCollapsed: boolean;
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
  | { type: 'set-compact'; compact: boolean }
  | { type: 'set-space-collapsed'; collapsed: boolean }
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
 * How wide the Workbar actually renders. At the native window floor the shell
 * may leave less than 340px even after hiding the sidebar. That measured cap
 * takes precedence over the normal drag minimum without changing the saved
 * preference, so widening the window restores the user's chosen width.
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
 * can fall below the normal Workbar drag minimum in a compact window.
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

function isCollapsedFor(state: WorkbarLayoutState, id: string | undefined): boolean {
  if (id === undefined) return true;
  if (state.compact) return state.compactCollapsed[id] ?? true;
  return Object.hasOwn(state.collapsedBySession, id) ? state.collapsedBySession[id]! : true;
}

export function isSessionWorkbarCollapsed(state: WorkbarLayoutState): boolean {
  return state.spaceCollapsed || isCollapsedFor(state, state.activeSessionId);
}

/** On a compact window a toggle only changes this narrow spell; otherwise it is the preference. */
function withCollapsedFor(
  state: WorkbarLayoutState,
  id: string | undefined,
  collapsed: boolean,
): WorkbarLayoutState {
  if (id === undefined || isCollapsedFor(state, id) === collapsed) return state;
  if (state.compact) {
    return {
      ...state,
      compactCollapsed: { ...state.compactCollapsed, [id]: collapsed },
    };
  }
  return { ...state, collapsedBySession: { ...state.collapsedBySession, [id]: collapsed } };
}

/* Every right-panel visibility command is a deliberate choice, and a choice
   ends a space suppression — even when the underlying reading already
   matches, because `withCollapsedFor` early-returns on that. */
function withRightCollapsed(state: WorkbarLayoutState, collapsed: boolean): WorkbarLayoutState {
  const next = withCollapsedFor(state, state.activeSessionId, collapsed);
  return next.spaceCollapsed ? { ...next, spaceCollapsed: false } : next;
}

/**
 * Entering compact hides every Workbar and leaves the preferences alone.
 * Leaving it promotes whatever the user chose for each Workbar meanwhile into
 * the preference, so widening never restores one the user closed and never
 * takes away one they opened.
 */
function withCompact(state: WorkbarLayoutState, compact: boolean): WorkbarLayoutState {
  if (state.compact === compact) return state;
  const collapsedBySession = compact
    ? state.collapsedBySession
    : { ...state.collapsedBySession, ...state.compactCollapsed };
  return { ...state, compact, compactCollapsed: {}, collapsedBySession, spaceCollapsed: false };
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

export function loadWorkbarLayout(activeSessionId?: string, compact = false): WorkbarLayoutState {
  return {
    panels: parseSessionWorkbarPanels(safeLocalStorageGet('maka-session-workbar-panels-v3')),
    activeSessionId,
    collapsedBySession: readSessionWorkbarCollapsed(),
    compact,
    compactCollapsed: {},
    bottomOpen: readSessionBottomPanelOpen(),
    spaceCollapsed: false,
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
  if (action.type === 'set-compact') return withCompact(state, action.compact);
  if (action.type === 'set-space-collapsed')
    return state.spaceCollapsed === action.collapsed
      ? state
      : { ...state, spaceCollapsed: action.collapsed };
  if (action.type === 'activate-session') {
    return state.activeSessionId === action.sessionId
      ? state
      : { ...state, activeSessionId: action.sessionId };
  }
  if (action.type === 'measure-right-ceiling') {
    // The shell keeps the 400px conversation floor even in a 600px window.
    // A Workbar the user opens there is allowed to be narrower than its
    // normal drag minimum; measurement never overwrites the saved preference.
    if (!Number.isFinite(action.ceiling)) return state;
    const ceiling = Math.max(0, Math.round(action.ceiling));
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
    const retained = ([id]: [string, unknown]) => id === state.activeSessionId || action.sessionIds.has(id);
    const entries = Object.entries(state.collapsedBySession).filter(retained);
    const overrides = Object.entries(state.compactCollapsed).filter(retained);
    return panels === state.panels
      && entries.length === Object.keys(state.collapsedBySession).length
      && overrides.length === Object.keys(state.compactCollapsed).length
      ? state
      : {
          ...state,
          panels,
          collapsedBySession: Object.fromEntries(entries),
          compactCollapsed: Object.fromEntries(overrides),
        };
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
      const maxWidth = sessionWorkbarMaxWidth(state);
      // Below the normal drag minimum there is no adjustable range. Keep the
      // preference until more space is available instead of saving the forced
      // narrow display width as the user's choice.
      if (maxWidth < SESSION_WORKBAR_MIN_WIDTH) return state;
      // A drag is the user's new preference, inside the space the container has.
      // Its start is the *displayed* width, so a narrowed window still drags
      // from what the user can see.
      const rightWidthPreference = clampSize(
        action.size,
        SESSION_WORKBAR_MIN_WIDTH,
        maxWidth,
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
    const next = { ...state, panels };
    return action.placement === 'right'
      ? withCollapsedFor(next, action.tab.ownerSessionId, false)
      : next;
  }
  // The flag-free reading: a panel action must not mint a collapse choice out
  // of a space suppression it had nothing to do with.
  let rightCollapsed = isCollapsedFor(state, state.activeSessionId);
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
