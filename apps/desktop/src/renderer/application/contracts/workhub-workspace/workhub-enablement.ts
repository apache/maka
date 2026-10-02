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
import { createContext, useContext, useEffect, useEffectEvent, useSyncExternalStore } from 'react';

/** Where the client-owned WorkHub switch is read; Desktop supplies it at composition. */
export interface WorkHubEnablementSource {
  read(): Promise<boolean>;
  subscribeChanges(handler: () => void): () => void;
}

/**
 * The one WorkHub switch the shell, Workbar, the rail and the dock follow.
 * It reads while anyone is subscribed and starts from off again afterwards,
 * as the shell's own state did. A failed read keeps the last known value, so
 * a transient settings error cannot leave the shell half-switched.
 */
export interface WorkHubEnablement {
  isEnabled(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createWorkHubEnablement(source: WorkHubEnablementSource): WorkHubEnablement {
  const listeners = new Set<() => void>();
  let enabled = false;
  let generation = 0;
  let unsubscribeSource: (() => void) | undefined;
  const refresh = async (readGeneration: number) => {
    try {
      const next = await source.read();
      if (readGeneration !== generation || next === enabled) return;
      enabled = next;
      for (const listener of [...listeners]) listener();
    } catch {
      // Keep the last known value.
    }
  };
  return {
    isEnabled: () => enabled,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const readGeneration = ++generation;
        unsubscribeSource = source.subscribeChanges(() => void refresh(readGeneration));
        void refresh(readGeneration);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        generation += 1;
        enabled = false;
        unsubscribeSource?.();
        unsubscribeSource = undefined;
      };
    },
  };
}

const EnablementContext = createContext<WorkHubEnablement | null>(null);
export const WorkHubEnablementProvider = EnablementContext.Provider;

/** Invocation-time reads, for commands that must not act while WorkHub is off. */
export function useWorkHubEnablement(): WorkHubEnablement {
  const enablement = useContext(EnablementContext);
  // A composition without the switch is a bug, not a WorkHub that is quietly off.
  if (!enablement) throw new Error('WorkHubEnablementProvider is missing');
  return enablement;
}

export function useWorkHubEnabled(): boolean {
  const enablement = useWorkHubEnablement();
  return useSyncExternalStore(enablement.subscribe, enablement.isEnabled);
}

/** Navigation the shell owns follows the switch: turning it on opens WorkHub, turning it off leaves it. */
export function WorkHubEnablementWatch(props: { onEnabled(): void; onDisabled(): void }) {
  const enablement = useWorkHubEnablement();
  const follow = useEffectEvent((enabled: boolean) => (enabled ? props.onEnabled() : props.onDisabled()));
  useEffect(() => {
    let followed = false;
    return enablement.subscribe(() => {
      const enabled = enablement.isEnabled();
      if (enabled === followed) return;
      followed = enabled;
      follow(enabled);
    });
  }, [enablement]);
  return null;
}
