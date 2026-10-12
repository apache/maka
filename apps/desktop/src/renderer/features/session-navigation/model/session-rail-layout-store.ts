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

import type { SideNavImperativeCollapseHandle } from '@astryxdesign/core/SideNav';
import type { SessionViewMode } from '@maka/ui';
import { createObservableState } from '../../../application/contracts/session-catalog/observable-state.js';
import { shellRailLayoutPort } from '../../../application/contracts/shell-layout-contract.js';
import {
  clampSessionListWidth,
  readSessionListCollapsed,
  readSessionListViewMode,
  readSessionListWidth,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
  writeSessionListCollapsed,
  writeSessionListViewMode,
  writeSessionListWidth,
} from './session-list-layout.js';

const LAYOUT_PERSIST_DEBOUNCE_MS = 200;

export interface SessionRailLayoutState {
  /** What the rail shows: the preference, or on a compact window only what
      the user opened there. Every reader wants this one. */
  readonly collapsed: boolean;
  readonly width: number;
  readonly viewMode: SessionViewMode;
}

/**
 * The rail's own geometry, as a store rather than `useState` in the shell
 * (#4109).
 *
 * Two readers want it and they are on opposite sides of the rail: the rail
 * renders at this width, and the window frame publishes it as
 * `--maka-sidenav-width` so the titlebar's session breadcrumb starts where the
 * column ends. Held as shell state it re-rendered the whole tree on every drag
 * frame; held here each side subscribes to the reading it uses.
 *
 * One rail exists per renderer and its persisted form is already a single
 * localStorage record, so the store is a module value: there is no second
 * instance for it to be an instance of.
 *
 * A compact window hides the rail without touching the stored preference.
 * Toggling it there is a choice for this narrow spell; when the window widens
 * the choice is promoted into the preference, so widening never restores a
 * rail the user closed and narrowing never rewrites what they stored. The
 * Workbar reveal may instead conceal the rail for the spell — a space
 * decision, not a choice, which the preference survives untouched.
 */
export function createSessionRailLayoutStore() {
  let preferredCollapsed = readSessionListCollapsed();
  let compact = false;
  let compactCollapsed: boolean | undefined;
  let spaceConcealed = false;
  const visibleCollapsed = () =>
    spaceConcealed || (compact ? (compactCollapsed ?? true) : preferredCollapsed);
  const state = createObservableState<SessionRailLayoutState>({
    collapsed: visibleCollapsed(),
    width: readSessionListWidth(),
    viewMode: readSessionListViewMode(),
  });
  const publishCollapsed = () => {
    const current = state.getState();
    const collapsed = visibleCollapsed();
    if (current.collapsed !== collapsed) state.replaceState({ ...current, collapsed });
  };
  const setPreferredCollapsed = (next: boolean) => {
    if (preferredCollapsed === next) return;
    preferredCollapsed = next;
    writeSessionListCollapsed(next);
  };
  const collapseHandleRef: { current: SideNavImperativeCollapseHandle | null } = { current: null };
  let widthPersistHandle: ReturnType<typeof setTimeout> | undefined;

  return {
    getState: state.getState,
    subscribe: state.subscribe,
    collapseHandleRef,
    setCollapsed(next: boolean): void {
      if (compact) {
        // Only a change the rail shows is a choice; repeating the visible
        // state must not mint a preference out of a policy or conceal hide.
        if (visibleCollapsed() !== next) compactCollapsed = next;
      } else setPreferredCollapsed(next);
      // A user action always ends a space concealment.
      spaceConcealed = false;
      publishCollapsed();
    },
    /** Hide the rail so the compact-window Workbar has grid room, or give it
        back. A space decision owned by the Workbar's compact spell — which is
        wider than this rail's own compact breakpoint — never a user choice,
        so the stored preference survives it untouched. */
    setSpaceConcealed(concealed: boolean): void {
      if (spaceConcealed === concealed) return;
      spaceConcealed = concealed;
      publishCollapsed();
    },
    /** The window's narrow reading, fed in by the feature's reads hook. */
    setCompact(next: boolean): void {
      if (compact === next) return;
      if (!next && compactCollapsed !== undefined) setPreferredCollapsed(compactCollapsed);
      compact = next;
      compactCollapsed = undefined;
      publishCollapsed();
    },
    /** Debounced: a drag reports a width per frame and only the last one is worth storing. */
    setWidth(next: number): void {
      // Astryx reports a collapse as `onSizeChange(0)`, from the button and from
      // a drag past the collapse threshold alike. That zero is the collapsed
      // geometry, not a width the user chose, and clamping it would overwrite
      // the remembered expanded width with the minimum. Every real width Astryx
      // reports is already clamped to `minWidth`, so anything below it is the
      // sentinel. The guard lives here rather than at the call site because the
      // call site moves — that is exactly how it was lost (#4109).
      if (next < SESSION_LIST_EXPANDED_MIN_WIDTH) return;
      const current = state.getState();
      const width = clampSessionListWidth(next);
      if (current.width === width) return;
      state.replaceState({ ...current, width });
      if (widthPersistHandle !== undefined) clearTimeout(widthPersistHandle);
      widthPersistHandle = setTimeout(() => {
        writeSessionListWidth(width);
      }, LAYOUT_PERSIST_DEBOUNCE_MS);
    },
    setViewMode(next: SessionViewMode): void {
      const current = state.getState();
      if (current.viewMode === next) return;
      state.replaceState({ ...current, viewMode: next });
      writeSessionListViewMode(next);
    },
  };
}

export type SessionRailLayoutStore = ReturnType<typeof createSessionRailLayoutStore>;

export const sessionRailLayoutStore: SessionRailLayoutStore = createSessionRailLayoutStore();

/* The Workbar controller's compact toggle reads the rail through the shell
   layout contract's port rather than importing this feature. */
shellRailLayoutPort.current = sessionRailLayoutStore;

/**
 * The whole geometry. Both readers use more than one field of it, and the store
 * replaces its state only when a field actually moved, so the identity is
 * already the comparison — a per-field selector would buy no granularity.
 */
export const selectRailLayout = (state: SessionRailLayoutState): SessionRailLayoutState => state;
