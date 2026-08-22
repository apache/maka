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

import { safeLocalStorageGet } from './browser-storage.js';

export type SessionWorkbarTabKind =
  | 'review'
  | 'terminal'
  | 'tasks'
  | 'browser'
  | 'files'
  | 'inspector'
  | 'side-chat';

export interface SessionWorkbarTab {
  id: string;
  kind: SessionWorkbarTabKind;
  /** Transient display title for dynamic tabs. Never persisted. */
  title?: string;
  /** Replaceable tab until the user pins or interacts with it. */
  preview?: boolean;
  /** Stable creation number for repeated tab kinds such as Terminal and Side chat. */
  ordinal?: number;
  resourceRef?: string;
  ownerSessionId?: string;
}

export interface SessionWorkbarTabsState {
  tabs: SessionWorkbarTab[];
  activeTabId: string | null;
  launcherOpen: boolean;
  /** Most-recent activation last; used as close fallback before adjacency. */
  activationHistory: string[];
}

export type SessionWorkbarPlacement = 'right' | 'bottom';

export interface SessionWorkbarPanelsState {
  right: SessionWorkbarTabsState;
  bottom: SessionWorkbarTabsState;
  focusedPanel: SessionWorkbarPlacement;
}

export interface PersistedSessionWorkbarTabs {
  version: 2;
  tabs: Array<Pick<SessionWorkbarTab, 'id' | 'kind'>>;
  activeTabId: string | null;
}

export interface PersistedSessionWorkbarPanels {
  version: 3;
  right: PersistedSessionWorkbarTabs;
  bottom: PersistedSessionWorkbarTabs;
  focusedPanel: SessionWorkbarPlacement;
}

const PERSISTED_KINDS = new Set<SessionWorkbarTabKind>([
  'review',
  'tasks',
  'browser',
  'files',
  'inspector',
]);

const STATIC_TAB_IDS: Record<Exclude<SessionWorkbarTabKind, 'side-chat'>, string> = {
  review: 'workbar:review',
  terminal: 'workbar:terminal',
  tasks: 'workbar:tasks',
  browser: 'workbar:browser',
  files: 'workbar:files',
  inspector: 'workbar:inspector',
};

export function staticSessionWorkbarTabId(
  kind: Exclude<SessionWorkbarTabKind, 'side-chat'>,
): string {
  return STATIC_TAB_IDS[kind];
}

export function terminalSessionWorkbarTabId(ref: string): string {
  return `terminal:${encodeURIComponent(ref)}`;
}

export function terminalRefFromWorkbarTab(
  tab: SessionWorkbarTab,
): string | null {
  if (tab.kind !== 'terminal') return null;
  if (tab.resourceRef) return tab.resourceRef;
  if (!tab.id.startsWith('terminal:')) return null;
  try {
    return decodeURIComponent(tab.id.slice('terminal:'.length));
  } catch {
    return null;
  }
}

export function createSessionWorkbarTabsState(
  tabs: readonly SessionWorkbarTab[] = [],
  activeTabId: string | null = null,
): SessionWorkbarTabsState {
  const normalized = dedupeTabs(tabs);
  const active = normalized.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : normalized[0]?.id ?? null;
  return {
    tabs: normalized,
    activeTabId: active,
    launcherOpen: normalized.length === 0,
    activationHistory: active ? [active] : [],
  };
}

export function createSessionWorkbarPanelsState(
  right: SessionWorkbarTabsState = createSessionWorkbarTabsState(),
  bottom: SessionWorkbarTabsState = createSessionWorkbarTabsState(),
  focusedPanel: SessionWorkbarPlacement = 'right',
): SessionWorkbarPanelsState {
  return { right, bottom, focusedPanel };
}

export function updateSessionWorkbarPanel(
  state: SessionWorkbarPanelsState,
  placement: SessionWorkbarPlacement,
  update: (panel: SessionWorkbarTabsState) => SessionWorkbarTabsState,
): SessionWorkbarPanelsState {
  const panel = update(state[placement]);
  return panel === state[placement] ? state : { ...state, [placement]: panel };
}

export function findSessionWorkbarTabPlacement(
  state: SessionWorkbarPanelsState,
  tabId: string,
): SessionWorkbarPlacement | null {
  if (state.right.tabs.some((tab) => tab.id === tabId)) return 'right';
  if (state.bottom.tabs.some((tab) => tab.id === tabId)) return 'bottom';
  return null;
}

export function findPreferredSideChatWorkbarTab(
  state: SessionWorkbarPanelsState,
): { placement: SessionWorkbarPlacement; tab: SessionWorkbarTab } | null {
  for (const placement of ['right', 'bottom'] as const) {
    const panel = state[placement];
    const activeTab = panel.tabs.find(
      (tab) => tab.id === panel.activeTabId && tab.kind === 'side-chat',
    );
    const tab = activeTab ?? panel.tabs.find((candidate) => candidate.kind === 'side-chat');
    if (tab) return { placement, tab };
  }
  return null;
}

export function openSessionWorkbarPanelTab(
  state: SessionWorkbarPanelsState,
  placement: SessionWorkbarPlacement,
  tab: SessionWorkbarTab,
): SessionWorkbarPanelsState {
  const existingPlacement = findSessionWorkbarTabPlacement(state, tab.id);
  if (existingPlacement && existingPlacement !== placement) {
    return moveSessionWorkbarTabToPanel(state, tab.id, placement);
  }
  const next = updateSessionWorkbarPanel(state, placement, (panel) =>
    openSessionWorkbarTab(panel, tab),
  );
  return { ...next, focusedPanel: placement };
}

export function activateSessionWorkbarPanelTab(
  state: SessionWorkbarPanelsState,
  placement: SessionWorkbarPlacement,
  tabId: string,
): SessionWorkbarPanelsState {
  const next = updateSessionWorkbarPanel(state, placement, (panel) =>
    activateSessionWorkbarTab(panel, tabId),
  );
  return next === state ? state : { ...next, focusedPanel: placement };
}

export function titleSessionWorkbarPanelTab(
  state: SessionWorkbarPanelsState,
  tabId: string,
  title: string,
): SessionWorkbarPanelsState {
  const placement = findSessionWorkbarTabPlacement(state, tabId);
  if (!placement) return state;
  return updateSessionWorkbarPanel(state, placement, (panel) =>
    titleSessionWorkbarTab(panel, tabId, title),
  );
}

export function pinSessionWorkbarPanelTab(
  state: SessionWorkbarPanelsState,
  tabId: string,
): SessionWorkbarPanelsState {
  const placement = findSessionWorkbarTabPlacement(state, tabId);
  if (!placement) return state;
  return updateSessionWorkbarPanel(state, placement, (panel) =>
    pinSessionWorkbarTab(panel, tabId),
  );
}

export function openSessionWorkbarPanelLauncher(
  state: SessionWorkbarPanelsState,
  placement: SessionWorkbarPlacement,
): SessionWorkbarPanelsState {
  const next = updateSessionWorkbarPanel(
    state,
    placement,
    openSessionWorkbarLauncher,
  );
  return { ...next, focusedPanel: placement };
}

export function closeSessionWorkbarPanelTabs(
  state: SessionWorkbarPanelsState,
  placement: SessionWorkbarPlacement,
  tabIds: readonly string[],
): SessionWorkbarPanelsState {
  const next = updateSessionWorkbarPanel(state, placement, (panel) =>
    closeSessionWorkbarTabs(panel, tabIds),
  );
  if (
    next.focusedPanel === placement &&
    next[placement].tabs.length === 0 &&
    next[placement === 'right' ? 'bottom' : 'right'].tabs.length > 0
  ) {
    return {
      ...next,
      focusedPanel: placement === 'right' ? 'bottom' : 'right',
    };
  }
  return next;
}

export function reorderSessionWorkbarPanelTab(
  state: SessionWorkbarPanelsState,
  placement: SessionWorkbarPlacement,
  tabId: string,
  targetTabId: string,
): SessionWorkbarPanelsState {
  const next = updateSessionWorkbarPanel(state, placement, (panel) =>
    reorderSessionWorkbarTab(panel, tabId, targetTabId),
  );
  return next === state ? state : { ...next, focusedPanel: placement };
}

export function moveSessionWorkbarPanelTab(
  state: SessionWorkbarPanelsState,
  placement: SessionWorkbarPlacement,
  tabId: string,
  direction: 'left' | 'right',
): SessionWorkbarPanelsState {
  const next = updateSessionWorkbarPanel(state, placement, (panel) =>
    moveSessionWorkbarTab(panel, tabId, direction),
  );
  return next === state ? state : { ...next, focusedPanel: placement };
}

export function moveSessionWorkbarTabToPanel(
  state: SessionWorkbarPanelsState,
  tabId: string,
  target: SessionWorkbarPlacement,
): SessionWorkbarPanelsState {
  const source = findSessionWorkbarTabPlacement(state, tabId);
  if (!source || source === target) return state;
  const tab = state[source].tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return state;
  const withoutSource = closeSessionWorkbarPanelTabs(state, source, [tabId]);
  const next = updateSessionWorkbarPanel(withoutSource, target, (panel) =>
    openSessionWorkbarTab(panel, tab),
  );
  return { ...next, focusedPanel: target };
}

export function openSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  tab: SessionWorkbarTab,
): SessionWorkbarTabsState {
  const existing = state.tabs.find((candidate) => candidate.id === tab.id);
  if (existing) {
    const preview =
      existing.preview === true && tab.preview !== true
        ? false
        : existing.preview === true;
    const next = {
      ...existing,
      ...tab,
      ...(preview ? { preview: true } : { preview: false }),
    };
    return {
      ...state,
      tabs: state.tabs.map((candidate) =>
        candidate.id === tab.id ? next : candidate,
      ),
      activeTabId: tab.id,
      launcherOpen: false,
      activationHistory: recordSessionWorkbarActivation(
        sessionWorkbarActivationHistory(state),
        tab.id,
      ),
    };
  }
  const replaced = tab.preview
    ? state.tabs.find((candidate) => candidate.preview === true)
    : undefined;
  const base = replaced
    ? closeSessionWorkbarTab(state, replaced.id)
    : state;
  return {
    tabs: [...base.tabs, tab],
    activeTabId: tab.id,
    launcherOpen: false,
    activationHistory: recordSessionWorkbarActivation(
      sessionWorkbarActivationHistory(base),
      tab.id,
    ),
  };
}

export function openStaticSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  kind: Exclude<SessionWorkbarTabKind, 'side-chat'>,
): SessionWorkbarTabsState {
  return openSessionWorkbarTab(state, {
    id: staticSessionWorkbarTabId(kind),
    kind,
  });
}

export function activateSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  tabId: string,
): SessionWorkbarTabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return {
    ...state,
    activeTabId: tabId,
    launcherOpen: false,
    activationHistory: recordSessionWorkbarActivation(
      sessionWorkbarActivationHistory(state),
      tabId,
    ),
  };
}

export function titleSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  tabId: string,
  title: string,
): SessionWorkbarTabsState {
  const normalized = title.trim();
  if (!normalized) return state;
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId || tab.title?.trim()) return tab;
    changed = true;
    return { ...tab, title: normalized };
  });
  return changed ? { ...state, tabs } : state;
}

export function pinSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  tabId: string,
): SessionWorkbarTabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId || tab.preview !== true) return tab;
    changed = true;
    return { ...tab, preview: false };
  });
  return changed ? { ...state, tabs } : state;
}

export function openSessionWorkbarLauncher(
  state: SessionWorkbarTabsState,
): SessionWorkbarTabsState {
  if (state.launcherOpen) return state;
  return { ...state, launcherOpen: true };
}

export function closeSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  tabId: string,
): SessionWorkbarTabsState {
  return closeSessionWorkbarTabs(state, [tabId]);
}

export function closeSessionWorkbarTabs(
  state: SessionWorkbarTabsState,
  tabIds: readonly string[],
): SessionWorkbarTabsState {
  const closing = new Set(tabIds);
  if (closing.size === 0 || !state.tabs.some((tab) => closing.has(tab.id))) {
    return state;
  }
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const tabs = state.tabs.filter((tab) => !closing.has(tab.id));
  if (tabs.length === 0) {
    return {
      tabs,
      activeTabId: null,
      launcherOpen: true,
      activationHistory: [],
    };
  }
  const activationHistory = sessionWorkbarActivationHistory(state).filter(
    (tabId) => !closing.has(tabId) && tabs.some((tab) => tab.id === tabId),
  );
  if (!state.activeTabId || !closing.has(state.activeTabId)) {
    return { ...state, tabs, activationHistory };
  }
  const next =
    [...activationHistory].reverse().find((tabId) =>
      tabs.some((tab) => tab.id === tabId),
    ) ??
    state.tabs
      .slice(Math.max(0, activeIndex + 1))
      .find((tab) => !closing.has(tab.id))?.id ??
    [...state.tabs.slice(0, Math.max(0, activeIndex))]
      .reverse()
      .find((tab) => !closing.has(tab.id))?.id ??
    tabs[0]!.id;
  return {
    tabs,
    activeTabId: next,
    launcherOpen: false,
    activationHistory: recordSessionWorkbarActivation(
      activationHistory,
      next,
    ),
  };
}

export function sessionWorkbarTabsExcept(
  state: SessionWorkbarTabsState,
  tabId: string,
): SessionWorkbarTab[] {
  return state.tabs.filter((tab) => tab.id !== tabId);
}

export function sessionWorkbarTabsToRight(
  state: SessionWorkbarTabsState,
  tabId: string,
): SessionWorkbarTab[] {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  return index < 0 ? [] : state.tabs.slice(index + 1);
}

export function reorderSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  tabId: string,
  targetTabId: string,
): SessionWorkbarTabsState {
  const sourceIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  const targetIndex = state.tabs.findIndex((tab) => tab.id === targetTabId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return state;
  }
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(sourceIndex, 1);
  if (!tab) return state;
  tabs.splice(targetIndex, 0, tab);
  return { ...state, tabs };
}

export function moveSessionWorkbarTab(
  state: SessionWorkbarTabsState,
  tabId: string,
  direction: 'left' | 'right',
): SessionWorkbarTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const targetIndex = direction === 'left' ? index - 1 : index + 1;
  const target = state.tabs[targetIndex];
  return target ? reorderSessionWorkbarTab(state, tabId, target.id) : state;
}

export function persistableSessionWorkbarTabs(
  state: SessionWorkbarTabsState,
): PersistedSessionWorkbarTabs {
  const tabs = state.tabs
    .filter((tab) => PERSISTED_KINDS.has(tab.kind) && tab.preview !== true)
    .map(({ id, kind }) => ({ id, kind }));
  return {
    version: 2,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : tabs[0]?.id ?? null,
  };
}

export function persistableSessionWorkbarPanels(
  state: SessionWorkbarPanelsState,
): PersistedSessionWorkbarPanels {
  return {
    version: 3,
    right: persistableSessionWorkbarTabs(state.right),
    bottom: persistableSessionWorkbarTabs(state.bottom),
    focusedPanel: state.focusedPanel,
  };
}

export function readSessionWorkbarPanels(): SessionWorkbarPanelsState {
  const raw = safeLocalStorageGet('maka-session-workbar-panels-v3');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSessionWorkbarPanels>;
      if (parsed.version === 3) {
        return createSessionWorkbarPanelsState(
          readPersistedPanel(parsed.right),
          readPersistedPanel(parsed.bottom),
          parsed.focusedPanel === 'bottom' ? 'bottom' : 'right',
        );
      }
    } catch {
      // Fall through to the v2 right-panel migration.
    }
  }
  return createSessionWorkbarPanelsState(readLegacySessionWorkbarTabs());
}

function readLegacySessionWorkbarTabs(): SessionWorkbarTabsState {
  const raw = safeLocalStorageGet('maka-session-workbar-tabs-v2');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSessionWorkbarTabs>;
      if (parsed.version === 2 && Array.isArray(parsed.tabs)) {
        const tabs = parsed.tabs.flatMap((candidate) => {
          if (
            !candidate ||
            typeof candidate.id !== 'string' ||
            !isSessionWorkbarTabKind(candidate.kind) ||
            !PERSISTED_KINDS.has(candidate.kind)
          ) {
            return [];
          }
          return [{ id: candidate.id, kind: candidate.kind }];
        });
        return createSessionWorkbarTabsState(
          tabs,
          typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
        );
      }
    } catch {
      // Fall through to the v1 active-tab migration.
    }
  }

  const legacy = safeLocalStorageGet('maka-session-workbar-tab-v1');
  if (
    legacy === 'review' ||
    legacy === 'terminal' ||
    legacy === 'tasks' ||
    legacy === 'browser' ||
    legacy === 'files' ||
    legacy === 'inspector'
  ) {
    return openStaticSessionWorkbarTab(createSessionWorkbarTabsState(), legacy);
  }
  return createSessionWorkbarTabsState();
}

function readPersistedPanel(
  value: PersistedSessionWorkbarTabs | undefined,
): SessionWorkbarTabsState {
  if (value?.version !== 2 || !Array.isArray(value.tabs)) {
    return createSessionWorkbarTabsState();
  }
  const tabs = value.tabs.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate.id !== 'string' ||
      !isSessionWorkbarTabKind(candidate.kind) ||
      !PERSISTED_KINDS.has(candidate.kind)
    ) {
      return [];
    }
    return [{ id: candidate.id, kind: candidate.kind }];
  });
  return createSessionWorkbarTabsState(
    tabs,
    typeof value.activeTabId === 'string' ? value.activeTabId : null,
  );
}

export function isSessionWorkbarTabKind(value: unknown): value is SessionWorkbarTabKind {
  return (
    value === 'review' ||
    value === 'terminal' ||
    value === 'tasks' ||
    value === 'browser' ||
    value === 'files' ||
    value === 'inspector' ||
    value === 'side-chat'
  );
}

function dedupeTabs(tabs: readonly SessionWorkbarTab[]): SessionWorkbarTab[] {
  const ids = new Set<string>();
  return tabs.filter((tab) => {
    if (!tab.id || !isSessionWorkbarTabKind(tab.kind) || ids.has(tab.id)) return false;
    ids.add(tab.id);
    return true;
  });
}

function recordSessionWorkbarActivation(
  history: readonly string[],
  tabId: string,
): string[] {
  return [...history.filter((candidate) => candidate !== tabId), tabId];
}

function sessionWorkbarActivationHistory(
  state: SessionWorkbarTabsState,
): readonly string[] {
  return state.activationHistory ?? (state.activeTabId ? [state.activeTabId] : []);
}
