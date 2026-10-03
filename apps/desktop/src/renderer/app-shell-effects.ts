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

import { useEffect, useEffectEvent } from 'react';
import { useHotkeys } from '@astryxdesign/core/hooks';
import type { ConnectionEvent } from '@maka/core/connections';
import type { SessionSummary } from '@maka/core/session';
import type { ThemePalette, ThemePreference } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import type { NavSelection } from '@maka/ui';
import { applyTheme, applyThemePalette } from './theme';
import { startTitlebarModalSync } from './titlebar-modal-sync';
import { safeLocalStorageSet } from './browser-storage';
import type { NavigationState } from './nav-selection.js';
import { createShellLifecycleHandlers } from './application/contracts/shell-lifecycle.js';

type RefBox<T> = { current: T };

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
  info(title: string, description?: string): void;
  toast(options: {
    title: string;
    description?: string;
    variant?: 'info' | 'error' | 'success' | 'warning';
    duration?: number;
    action?: { label: string; onClick: () => void };
  }): void;
};

export function useAppShellNavRefSync(options: { navSelection: NavSelection; navSelectionRef: RefBox<NavSelection> }) {
  useEffect(() => {
    options.navSelectionRef.current = options.navSelection;
  }, [options.navSelection]);
}

export function useAppShellHostEffects() {
  // The host-OS tag on the document is applied by ShellLifecycleSubscriptions.
  // Modal-open titlebar dimming/hiding is driven by observing the top layer
  // (`dialog:modal`) rather than the shell's own modal state, so dialogs
  // mounted deep in module pages — the scheduled-task form above all — are
  // covered too. See titlebar-modal-sync.ts.
  useEffect(() => startTitlebarModalSync(), []);
}

export function useAppShellPersistenceEffects(options: {
  navigationState: NavigationState;
  themePalette: ThemePalette;
  themePref: ThemePreference;
}) {
  // Keep <html class="dark"> in sync with the active preference. The Settings
  // modal also calls applyTheme on local change so the effect is immediate,
  // but this keeps the listener for 'auto' alive at the app level.
  useEffect(() => {
    const unsubscribe = applyTheme(options.themePref);
    return unsubscribe;
  }, [options.themePref]);

  // PR-THEME-APPLY-AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): re-apply the
  // palette data attribute whenever the persisted setting changes, so
  // switching themes in Settings is immediately visible. Previously the
  // attribute was only set once at mount, so a palette change required a
  // restart before the new colors took effect.
  useEffect(() => {
    applyThemePalette(options.themePalette);
  }, [options.themePalette]);

  // Persist the active destination and each hub's last selected module.
  // Strict localStorage availability check — Vite dev sometimes runs through
  // a worker where it isn't defined.
  useEffect(() => {
    safeLocalStorageSet('maka-nav-selection-v1', JSON.stringify(options.navigationState));
  }, [options.navigationState]);
}

export function useAppShellBootstrapSubscriptions(options: {
  uiLocale: UiLocale;
  activeIdRef: Readonly<RefBox<string | undefined>>;
  applyE2eFixture: () => Promise<void>;
  bootstrapSessions: () => Promise<void>;
  clearPendingTurnActionsForSession: (sessionId: string) => void;
  /** Releases a send's pending claim once the authority names that turn. */
  createSession: () => Promise<void> | void;
  handleConnectionEvent: (event: ConnectionEvent) => void;
  openHelp: () => void;
  openSettings: () => void;
  clearPendingTurnActions: () => void;
  refreshConnections: () => Promise<void>;
  refreshMemoryActive: (failureContext?: 'load') => Promise<void>;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshProjects: () => Promise<unknown>;
  refreshShellSettings: () => Promise<void>;
  refreshSessions: () => Promise<SessionSummary[]>;
  refreshChangedSession: (sessionId: string) => Promise<void>;
  rendererMountedRef: RefBox<boolean>;
  retireSession: (sessionId: string) => void;
  retiredSessionIds(sessions: readonly { id: string }[]): string[];
  /** A targeted row read committed this id's authoritative absence. */
  isSessionRemoved(sessionId: string): boolean;
  /** Mirrors the committed catalog; refresh promises resolve after commit. */
  sessionsRef: RefBox<readonly SessionSummary[]>;
  recordSessionChange(sessionId: string, ts: number): void;
  toastApi: ToastApi;
}) {
  const runDeferredStartupRefreshes = useEffectEvent(() => {
    void options.bootstrapSessions();
    void options.applyE2eFixture();
  });
  // Both shortcuts fire while the composer has focus — they always did, and
  // that is the point of a global new-task / settings key — so both opt out of
  // the hook's default "stay silent while typing" rule.
  //
  // The shiftKey bail keeps the original "plain N only" contract: useHotkeys
  // ignores shift state unless the combo names it, and there is no way to spell
  // "must NOT be shifted", so the entry matches ⇧⌘N and the handler declines
  // it. Net app behavior is unchanged (⇧⌘N did nothing before and does nothing
  // now); the only residual difference is that the hook has already called
  // preventDefault() by the time we decline.
  useHotkeys([
    {
      keys: 'mod+,',
      allowInInputs: true,
      onPress: () => options.openSettings(),
    },
    {
      keys: 'mod+n',
      allowInInputs: true,
      onPress: (event) => {
        if (event.shiftKey) return;
        void options.createSession();
      },
    },
  ]);
  const markRendererMounted = useEffectEvent(() => {
    options.rendererMountedRef.current = true;
  });
  const cleanupPendingRefs = useEffectEvent(() => {
    options.rendererMountedRef.current = false;
    options.clearPendingTurnActions();
  });

  useEffect(() => {
    // The default Host seeds sessions + connections through onboarding.
    // `refreshSessions` below expands that seed across every ready Host.
    // `refreshShellSettings` is
    // waited because it drives theme + locale before first paint settles.
    // Everything else is fire-and-forget on a rAF to keep the critical
    // render path as short as possible. ShellLifecycleSubscriptions holds the
    // event subscriptions for the same lifetime.
    void options.refreshShellSettings();
    // Non-critical: defer to next frame so the first paint isn't blocked.
    const startupFrame = requestAnimationFrame(runDeferredStartupRefreshes);
    markRendererMounted();
    return () => {
      cancelAnimationFrame(startupFrame);
      cleanupPendingRefs();
    };
  }, []);
  return createShellLifecycleHandlers(options);
}
