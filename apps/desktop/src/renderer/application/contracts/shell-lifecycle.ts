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

const DETACHED: ShellLifecycleSources = {
  tagDocumentPlatform: () => () => {},
  subscribeWindowCommands: () => () => {},
  subscribeConnectionEvents: () => () => {},
  subscribeRuntimeHostChanges: () => () => {},
  subscribeClientSettingsChanges: () => () => {},
  subscribeExternalSettingsChanges: () => () => {},
};
const SourcesContext = createContext<ShellLifecycleSources>(DETACHED);
export const ShellLifecycleSourcesProvider = SourcesContext.Provider;

/** Subscribes for the shell's lifetime; each event reaches the shell's latest handler. */
export function ShellLifecycleSubscriptions(handlers: ShellLifecycleHandlers) {
  const sources = useContext(SourcesContext);
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
