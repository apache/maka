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

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

export interface NewTaskChoiceProjectHandoff {
  readonly fromKey: string;
  readonly toKey: string;
  readonly token: number;
}

export interface NewTaskChoiceProjectHandoffStore {
  getSnapshot(): NewTaskChoiceProjectHandoff | undefined;
  subscribe(listener: () => void): () => void;
  publish(input: Omit<NewTaskChoiceProjectHandoff, 'token'>): void;
  consume(token: number): void;
}

export function createNewTaskChoiceProjectHandoffStore(): NewTaskChoiceProjectHandoffStore {
  let current: NewTaskChoiceProjectHandoff | undefined;
  let nextToken = 1;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(input) {
      current = { ...input, token: nextToken++ };
      notify();
    },
    consume(token) {
      if (current?.token !== token) return;
      current = undefined;
      notify();
    },
  };
}

const NewTaskChoiceProjectHandoffContext = createContext<NewTaskChoiceProjectHandoffStore | null>(null);

export function NewTaskChoiceProjectHandoffProvider({
  store,
  children,
}: {
  readonly store: NewTaskChoiceProjectHandoffStore;
  readonly children: ReactNode;
}) {
  return (
    <NewTaskChoiceProjectHandoffContext.Provider value={store}>
      {children}
    </NewTaskChoiceProjectHandoffContext.Provider>
  );
}

export function useNewTaskChoiceProjectHandoff(): {
  readonly handoff: NewTaskChoiceProjectHandoff | undefined;
  consume(token: number): void;
} {
  const store = useContext(NewTaskChoiceProjectHandoffContext);
  const handoff = useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getSnapshot ?? (() => undefined),
    () => undefined,
  );
  return {
    handoff,
    consume: (token) => store?.consume(token),
  };
}
