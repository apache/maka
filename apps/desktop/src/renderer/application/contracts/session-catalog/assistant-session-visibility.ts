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

import { createContext, useContext, useSyncExternalStore } from 'react';

export interface AssistantSessionVisibilitySource {
  read(): Promise<boolean>;
  write(value: boolean): Promise<void>;
  subscribeChanges(listener: () => void): () => void;
}
export function createAssistantSessionVisibility(source: AssistantSessionVisibilitySource) {
  let visible = false;
  let generation = 0;
  let revision = 0;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: boolean) => {
    if (next === visible) return;
    visible = next;
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    const currentGeneration = generation;
    const currentRevision = ++revision;
    try {
      const value = await source.read();
      if (generation === currentGeneration && revision === currentRevision) publish(value);
    } catch { /* Keep the last confirmed preference on a transient read failure. */ }
  };
  return {
    getSnapshot: () => visible,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        generation++;
        unsubscribe = source.subscribeChanges(() => void refresh());
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation++;
          unsubscribe?.();
          visible = false;
        }
      };
    },
    async setVisible(value: boolean) {
      await source.write(value);
      revision++;
      publish(value);
    },
  };
}
export type AssistantSessionVisibility = ReturnType<typeof createAssistantSessionVisibility>;
const Context = createContext<AssistantSessionVisibility | null>(null);
export const AssistantSessionVisibilityProvider = Context.Provider;
export function useAssistantSessionVisibility() {
  const store = useContext(Context);
  if (!store) throw Error('AssistantSessionVisibilityProvider is missing');
  return store;
}
export function useShowAssistantBackgroundSessions() {
  const store = useAssistantSessionVisibility();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
