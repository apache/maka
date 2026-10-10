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
/**
 * The root's application lifecycle events (#4582 M5).
 *
 * AppShell still reacts to these across regions — Session and Host refreshes,
 * the settings mirrors, connection projections, the window menu — so the
 * reactions stay a documented root lifecycle. What leaves the shell is the
 * environment: Desktop supplies these sources at composition, and
 * `ShellLifecycleSubscriptions` is the one place that subscribes to them.
 */

import { createContext, useContext, useEffect, useEffectEvent } from 'react';
import type { ConnectionEvent } from '@maka/core/connections';
import type { SessionChangedEvent } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './conversation-copy.js';
import { handleSessionChangedEvent } from './session-catalog/session-change-effects.js';
import { useSessionCatalogController } from './session-catalog/session-catalog-state.js';

export interface ShellWindowCommand {
  readonly id: 'newTask' | 'openSettings' | 'openHelp';
}

export interface ShellRuntimeHostChange {
  readonly readiness: 'connecting' | 'ready' | 'reconnecting' | 'unavailable';
  readonly isDefault: boolean;
}

export interface ShellLifecycleSources {
  /** Tags the document with the host OS for platform chrome; returns a cancel. */
  tagDocumentPlatform(): () => void;
  subscribeWindowCommands(handler: (command: ShellWindowCommand) => void): () => void;
  subscribeConnectionEvents(handler: (event: ConnectionEvent) => void): () => void;
  subscribeRuntimeHostChanges(handler: (event: ShellRuntimeHostChange) => void): () => void;
  subscribeClientSettingsChanges(handler: () => void): () => void;
  subscribeExternalSettingsChanges(handler: () => void): () => void;
}

/** What the shell does with each event; Session changes come from the catalog's own feed. */
export interface ShellLifecycleHandlers {
  onWindowCommand(command: ShellWindowCommand): void;
  onConnectionEvent(event: ConnectionEvent): void;
  onRuntimeHostChange(event: ShellRuntimeHostChange): void;
  onClientSettingsChanged(): void;
  onExternalSettingsChanged(): void;
  onSessionChange(event: SessionChangedEvent): void;
}

/** What the shell's reactions call; the Session-change part is the catalog's change effects. */
export interface ShellLifecycleReactions
  extends Omit<Parameters<typeof handleSessionChangedEvent>[1], 'notifyModelRebound'> {
  uiLocale: UiLocale;
  createSession(): Promise<void> | void;
  openSettings(): void;
  openHelp(): void;
  handleConnectionEvent(event: ConnectionEvent): void;
  refreshConnections(): Promise<void>;
  refreshMemoryActive(failureContext?: 'load'): Promise<void>;
  refreshShellSettings(): Promise<void>;
  toastApi: { info(title: string, description?: string): void };
}

/** The shell's reaction to each event, built per render so each reads current state. */
export function createShellLifecycleHandlers(reactions: ShellLifecycleReactions): ShellLifecycleHandlers {
  const refreshRuntimeHostSettingsMirrors = () => {
    void reactions.refreshShellSettings();
    void reactions.refreshConnections();
  };
  return {
    onConnectionEvent: reactions.handleConnectionEvent,
    onRuntimeHostChange(event) {
      void reactions.refreshSessions().then(() => {
        reactions.retiredSessionIds(reactions.sessionsRef.current).forEach(reactions.retireSession);
      });
      if (event.readiness !== 'ready') return;
      if (!event.isDefault) return;
      refreshRuntimeHostSettingsMirrors();
      void reactions.refreshProjects();
      void reactions.refreshMemoryActive('load');
    },
    onExternalSettingsChanged: refreshRuntimeHostSettingsMirrors,
    onClientSettingsChanged: () => void reactions.refreshShellSettings(),
    onSessionChange: (event) =>
      handleSessionChangedEvent(event, {
        ...reactions,
        notifyModelRebound: (modelId) => {
          const copy = getDesktopConversationCopy(reactions.uiLocale).actions;
          reactions.toastApi.info(copy.modelReboundTitle, copy.modelReboundDescription(modelId));
        },
      }),
    // PR-2088: the macOS application menu routes New Task / Settings / Keyboard
    // Shortcuts here through one channel. The renderer already owns these
    // implementations; the menu is only a second entry surface. The keydown
    // path (the shell's useHotkeys) stays active on every platform: on macOS
    // AppKit resolves the menu accelerator before the web contents sees the
    // keydown, so a real keypress dispatches exactly once, while CDP-injected
    // test keys still reach this handler for the renderer path.
    onWindowCommand(command) {
      if (command.id === 'newTask') void reactions.createSession();
      else if (command.id === 'openSettings') reactions.openSettings();
      else if (command.id === 'openHelp') reactions.openHelp();
    },
  };
}

const SourcesContext = createContext<ShellLifecycleSources | null>(null);
export const ShellLifecycleSourcesProvider = SourcesContext.Provider;

/** Subscribes for the shell's lifetime; each event reaches the shell's latest handler. */
export function ShellLifecycleSubscriptions(handlers: ShellLifecycleHandlers) {
  const sources = useContext(SourcesContext);
  if (!sources) throw new Error('ShellLifecycleSourcesProvider is missing');
  const catalog = useSessionCatalogController();
  const onWindowCommand = useEffectEvent(handlers.onWindowCommand);
  const onConnectionEvent = useEffectEvent(handlers.onConnectionEvent);
  const onRuntimeHostChange = useEffectEvent(handlers.onRuntimeHostChange);
  const onClientSettingsChanged = useEffectEvent(handlers.onClientSettingsChanged);
  const onExternalSettingsChanged = useEffectEvent(handlers.onExternalSettingsChanged);
  const onSessionChange = useEffectEvent(handlers.onSessionChange);
  useEffect(() => sources.tagDocumentPlatform(), [sources]);
  useEffect(() => {
    const unsubscribes = [
      sources.subscribeConnectionEvents(onConnectionEvent),
      sources.subscribeRuntimeHostChanges(onRuntimeHostChange),
      sources.subscribeExternalSettingsChanges(onExternalSettingsChanged),
      sources.subscribeClientSettingsChanges(onClientSettingsChanged),
      catalog.source.subscribeChanges(onSessionChange),
      sources.subscribeWindowCommands(onWindowCommand),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [catalog, sources]);
  return null;
}
