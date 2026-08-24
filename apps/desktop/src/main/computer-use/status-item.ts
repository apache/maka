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

import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Menu as MenuType, Tray } from 'electron';
import { resolveSystemUiLocale, type UiCatalog, type UiLocale } from '@maka/core/ui-locale';
import type { CuOverlayHook } from '@maka/runtime/computer-use-types';

// Electron is CommonJS, and named imports from it fail outside a main process.
// Deferring the require keeps this module loadable under plain `node --test`,
// where every Electron touchpoint is injected instead.
const electron = (): typeof import('electron') =>
  createRequire(import.meta.url)('electron') as typeof import('electron');

/**
 * The menu bar indicator for Computer Use.
 *
 * The agent cursor can only be drawn when the target window is visible, and
 * during ordinary background work it usually is not — the user is looking at
 * something else, and the window being driven is underneath it. That leaves no
 * signal at all that the agent is touching the machine. Codex solves this with
 * a status item (`CUAServiceStatusItemController`), which is always visible
 * regardless of what covers what.
 *
 * Modelled on that controller, including what it deliberately does NOT do:
 *  - no timers, no animation, and no second "idle" artwork. The item has one
 *    glyph. Codex's only visual state is `isPressed`, which macOS already draws
 *    for an Electron `Tray` without being asked.
 *  - visibility is bound to the number of live sessions, not to how recently an
 *    action happened (`statusItem.isVisible = sessions.count != 0`). An item
 *    that fades to a dimmer icon two seconds after the last click is reporting
 *    the age of an event; this one reports whether anything is still running.
 *  - one menu row per live session, titled with the app that session is driving.
 *
 * The glyph is the agent cursor itself — the same shape and the same brand blue
 * the on-screen cursor is drawn with, so the menu bar and the screen are visibly
 * the same agent. It deliberately opts out of template rendering to keep that
 * colour.
 */
export interface ComputerUseStatusItem {
  /**
   * This session just drove the machine. Shows the item if it was hidden.
   */
  noteSessionActive(sessionId: string): void;
  /**
   * Name the app this session is driving, for its menu row.
   *
   * Only knowable once an action completes and reports the window it landed on,
   * so it arrives one beat after `noteSessionActive`. Ignored for sessions that
   * are no longer live: a result can land after the user has already stopped
   * the session, and resurrecting the item then would be a lie.
   */
  noteSessionApp(sessionId: string, appName: string | undefined): void;
  /**
   * Install what "Stop Using …" does.
   *
   * Set after construction because the stop path lives with the session IPC,
   * which is assembled later than the tool surface that owns this item.
   */
  setStopHandler(handler: (sessionId: string) => void): void;
  /** The session is no longer using the computer. Hides the item at zero. */
  clearForSession(sessionId: string): void;
  destroy(): void;
  /** Test seam. */
  isVisible(): boolean;
}

export interface ComputerUseStatusItemDeps {
  resourcesDir?: string;
  createTray?: (image: Electron.NativeImage) => Tray;
  onStopRequested?: (sessionId: string) => void;
  /**
   * Called when the number of live sessions crosses zero in either direction.
   *
   * The item's visibility already answers "is anything driving the machine",
   * which is also the exact interval the system must not suspend for: Computer
   * Use does its work while the user is idle — the physical-input guard
   * requires it — and that is precisely when idle sleep lands and kills the
   * run. Rather than a second registry of the same sessions, the authority on
   * that question reports it.
   */
  onLiveChanged?: (live: boolean) => void;
  /**
   * The UI locale for the menu, read fresh on each rebuild.
   *
   * These rows were English literals in an app that resolves a locale at boot
   * and whose picture-in-picture sibling labels the same two actions in
   * Chinese, so the menu bar and the mirror disagreed about what language the
   * product speaks. Sync, because a menu template is built synchronously;
   * defaults to the system language, which is also used for other
   * main-process strings.
   */
  resolveLocale?: () => UiLocale;
  /** Registers a listener for resolved-locale changes. */
  subscribeLocaleChanges?: (listener: () => void) => () => void;
  /** Test seams: the contract is drivable without an Electron main process. */
  loadImage?: () => Electron.NativeImage;
  buildMenu?: (template: Electron.MenuItemConstructorOptions[]) => MenuType;
}

interface StatusItemCopy {
  /** The row for a session whose target application is known. */
  stopUsing(appName: string): string;
  /**
   * What a row says when the app is not known yet.
   *
   * The first action of a session shows the item before any result has come
   * back, so for one beat we know that something is being driven but not what.
   * Naming an app we have not observed would be a guess; this says exactly
   * what is true.
   */
  stopUnnamed: string;
  /** Codex's empty state. Reachable only if a menu outlives its rows. */
  empty: string;
}

const COPY: UiCatalog<StatusItemCopy> = {
  zh: {
    stopUsing: (appName) => `停止操作 ${appName}`,
    stopUnnamed: '停止 Computer Use',
    empty: '没有正在进行的任务',
  },
  en: {
    stopUsing: (appName) => `Stop Using ${appName}`,
    stopUnnamed: 'Stop Computer Use',
    empty: 'No Active Sessions',
  },
};

function defaultResolveLocale(): UiLocale {
  // Lazy on purpose: tool assembly runs at module load, before
  // `app.whenReady()`, and this is only ever called while building a menu for
  // a tray that by definition already exists.
  try {
    return resolveSystemUiLocale(electron().app.getPreferredSystemLanguages());
  } catch {
    return 'en';
  }
}

function defaultResourcesDir(): string {
  // Packaged: resources live beside the app. Dev: repo layout.
  return process.resourcesPath && electron().app.isPackaged
    ? join(process.resourcesPath, 'status')
    : join(electron().app.getAppPath(), 'resources', 'status');
}

/**
 * The backend falls back to `pid:1234` when the window has no application name.
 * That is a correct identifier and a terrible menu row, so it counts as unknown
 * and takes the generic title rather than "Stop Using pid:1234".
 */
function appTitle(copy: StatusItemCopy, appName: string | undefined): string {
  const trimmed = appName?.trim() ?? '';
  if (trimmed.length === 0 || /^pid:\d+$/.test(trimmed)) return copy.stopUnnamed;
  return copy.stopUsing(trimmed);
}

export function createComputerUseStatusItem(
  deps: ComputerUseStatusItemDeps = {},
): ComputerUseStatusItem {
  const load =
    deps.loadImage ??
    ((): Electron.NativeImage => {
      const dir = deps.resourcesDir ?? defaultResourcesDir();
      const image = electron().nativeImage.createFromPath(join(dir, 'cu-status.png'));
      // NOT a template image. macOS recolours template art to match the menu
      // bar, which would repaint this to black — and a black arrow beside
      // Codex's black arrow is two identical icons doing different things.
      // Carrying Maka's cursor blue keeps them distinguishable at a glance, and
      // it reads on both light and dark menu bars.
      image.setTemplateImage(false);
      return image;
    });
  const buildMenu =
    deps.buildMenu ??
    ((t: Electron.MenuItemConstructorOptions[]) => electron().Menu.buildFromTemplate(t));

  let tray: Tray | null = null;
  let icon: Electron.NativeImage | null = null;
  let stopHandler: ((sessionId: string) => void) | undefined = deps.onStopRequested;
  /** Live sessions in the order they started driving → the app each one drives. */
  const sessions = new Map<string, string | undefined>();

  function image(): Electron.NativeImage {
    if (!icon) icon = load();
    return icon;
  }

  function menuTemplate(): Electron.MenuItemConstructorOptions[] {
    const copy = COPY[(deps.resolveLocale ?? defaultResolveLocale)()] ?? COPY.en;
    const entries = [...sessions.entries()];
    if (entries.length === 0) return [{ label: copy.empty, enabled: false }];
    // Two sessions driving the same app produce two identical rows, and a menu
    // with two identical rows cannot be used. Codex numbers them; so do we, and
    // for the same reason we number identical generic rows too.
    const totals = new Map<string, number>();
    for (const [, app] of entries) {
      const title = appTitle(copy, app);
      totals.set(title, (totals.get(title) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return entries.map(([id, app]) => {
      const title = appTitle(copy, app);
      const ordinal = (seen.get(title) ?? 0) + 1;
      seen.set(title, ordinal);
      return {
        label: (totals.get(title) ?? 0) > 1 ? `${title} (${ordinal})` : title,
        enabled: stopHandler !== undefined,
        click: () => {
          stopHandler?.(id);
        },
      };
    });
  }

  function rebuildMenu(): void {
    if (!tray) return;
    tray.setContextMenu(buildMenu(menuTemplate()));
  }

  function ensureTray(): void {
    if (tray) return;
    const created = deps.createTray ? deps.createTray(image()) : new (electron().Tray)(image());
    created.setIgnoreDoubleClickEvents(true);
    tray = created;
  }

  function hide(): void {
    tray?.destroy();
    tray = null;
  }

  const unsubscribeLocale = deps.subscribeLocaleChanges?.(rebuildMenu) ?? (() => undefined);

  return {
    noteSessionActive(sessionId: string): void {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      if (sessions.has(sessionId)) {
        // Nothing about the item depends on how many actions a session has run,
        // which is why there is no timer here and nothing to restart.
        return;
      }
      sessions.set(sessionId, undefined);
      ensureTray();
      rebuildMenu();
      if (sessions.size === 1) deps.onLiveChanged?.(true);
    },

    noteSessionApp(sessionId: string, appName: string | undefined): void {
      if (!sessions.has(sessionId)) return;
      const next = appName?.trim() ?? '';
      if (next.length === 0) return;
      if (sessions.get(sessionId) === next) return;
      sessions.set(sessionId, next);
      rebuildMenu();
    },

    setStopHandler(handler: (sessionId: string) => void): void {
      stopHandler = handler;
      rebuildMenu();
    },

    clearForSession(endedSessionId: string): void {
      if (!sessions.delete(endedSessionId)) return;
      if (sessions.size === 0) {
        hide();
        deps.onLiveChanged?.(false);
        return;
      }
      rebuildMenu();
    },

    destroy(): void {
      unsubscribeLocale();
      const wasLive = sessions.size > 0;
      sessions.clear();
      hide();
      if (wasLive) deps.onLiveChanged?.(false);
    },

    isVisible(): boolean {
      return tray !== null;
    },
  };
}

/**
 * Drive the status item from the same hook that drives the cursor.
 *
 * Deliberately wraps rather than replaces: the cursor declines to draw whenever
 * the target window is covered, and those are exactly the actions the user most
 * needs told about. The status item sees every action either way.
 *
 * `onActionEnd` is where the app name comes from. The hook context carries only
 * the session, but a completed action reports the observation it landed on, and
 * that observation names the application — so the menu can say "Stop Using
 * Safari" without any new plumbing through the runtime.
 */
export function withComputerUseStatusItem(
  hook: CuOverlayHook,
  statusItem: ComputerUseStatusItem,
): CuOverlayHook {
  return {
    onActionBegin(action, context) {
      statusItem.noteSessionActive(context.sessionId);
      return hook.onActionBegin(action, context);
    },
    onActionEnd(action, result, context) {
      statusItem.noteSessionApp(context.sessionId, result?.observation?.appId);
      return hook.onActionEnd?.(action, result, context);
    },
  };
}
