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

/* The Desktop shell's width contract for the renderer: the media queries each
   feature subscribes to. The native window floor these widths derive from is
   `SHELL_WINDOW_MIN_WIDTH` in `src/shared/shell-layout-contract.ts`, which the
   main process reads; renderer features must not import from `src/shared`
   (every `src/shared` path joined through AppShell is AppShell-closure debt). */

/**
 * At or below these widths a panel is hidden unless the user opened it while
 * the window was this narrow. The Workbar goes first: past 1080 a 480px Workbar
 * leaves the conversation less than its comfortable width beside a default
 * sidebar. The sidebar follows at 820, where it alone would.
 */
export const SHELL_WORKBAR_COMPACT_QUERY = '(max-width: 1080px)';
export const SHELL_SIDEBAR_COMPACT_QUERY = '(max-width: 820px)';

/** Settings drops its section rail into a picker at this width. */
export const SHELL_SETTINGS_NARROW_QUERY = '(max-width: 760px)';

/* JS mirrors of the CSS lengths the compact-window checks below need. Neither
   JS nor container queries can resolve var(), so these duplicate
   `--maka-conversation-min-width` and `--agents-content-area-gap` from
   maka-tokens.css — the shell-layout-widths test pins all copies equal. */
export const SHELL_CONVERSATION_MIN_WIDTH_PX = 400;
export const SHELL_CONTENT_AREA_GAP_PX = 4;

/**
 * The room the frame leaves the Workbar beside the drawn rail, mirroring
 * `WORKBAR_CAP` in shell/frame-style.ts: `100cqi` is the window's inline size
 * and `--maka-sidenav-width` the drawn rail. Callers compare the result
 * against the Workbar's own minimum to tell "squeezed out of the grid" from
 * "sharing it". The rail's preferred width stands in for its drawn width:
 * where the frame caps the rail this expression is already negative, so the
 * verdict is the same.
 */
export function shellWorkbarGridRoom(
  windowWidthPx: number,
  railWidthPx: number,
): number {
  return Math.max(
    0,
    windowWidthPx - railWidthPx - SHELL_CONVERSATION_MIN_WIDTH_PX - 2 * SHELL_CONTENT_AREA_GAP_PX,
  );
}

/** The rail's geometry, read for the compact-window panel mutual exclusion. */
export interface ShellRailLayoutPort {
  getState(): { collapsed: boolean; width: number };
  /** Fires when the visible geometry changes — including the user expanding
      the rail under an open Workbar. */
  subscribe(listener: () => void): () => void;
  setCollapsed(collapsed: boolean): void;
  /** Hide the rail so the compact Workbar has room, or restore it: a space
      decision the caller revokes when the spell ends, unlike `setCollapsed`,
      which the user owns. The rail's own compact breakpoint is narrower than
      the Workbar's, so this is not gated on it. */
  setSpaceConcealed(concealed: boolean): void;
}

/* The rail's layout store registers itself at module init; the Workbar
   controller reads it at toggle time. Features cannot import each other, so
   the two sides meet here rather than through AppShell, where every wiring
   field is ratcheted debt. */
export const shellRailLayoutPort: { current: ShellRailLayoutPort | undefined } = {
  current: undefined,
};
