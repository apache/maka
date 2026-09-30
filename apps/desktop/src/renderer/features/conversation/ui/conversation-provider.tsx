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

import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useConversationController } from '../controller/use-conversation-controller.js';
import { useSessionMessageQueue } from '../controller/use-session-message-queue.js';
import { useSessionUiRead } from '../controller/use-session-ui-read.js';
import { ConversationContext } from './conversation-context.js';

const QueueContext = createContext<ReturnType<typeof useSessionMessageQueue> | null>(null);
const QueueCommandsContext = createContext<Omit<ReturnType<typeof useSessionMessageQueue>, 'transientMessages'> | null>(null);
export function useConversationQueue() {
  const value = useContext(QueueContext);
  if (!value) throw new Error('ConversationProvider is required');
  return value;
}
export function useConversationQueueCommands() {
  const value = useContext(QueueCommandsContext);
  if (!value) throw new Error('ConversationProvider is required');
  return value;
}
export function ConversationProvider({ children }: { children: ReactNode }) {
  const controller = useConversationController();
  const { workspace } = controller;
  const [context] = useState(controller);
  const composer = useSyncExternalStore(workspace.composer.subscribe, workspace.composer.getSnapshot);
  const queue = useSessionUiRead(workspace.ui.reads, 'queue', composer.sessionId);
  const surface = useSessionMessageQueue({ ...composer, queue, activeSessionId: workspace.activeIdRef });
  const current = useRef(surface);
  useLayoutEffect(() => { current.current = surface; });
  const [commands] = useState(() => ({
    composer: surface.composer,
    draftContextRestorer: surface.draftContextRestorer,
    restoreDraft: surface.restoreDraft,
    promoteQueuedEntry: (...args: Parameters<typeof surface.promoteQueuedEntry>) => current.current.promoteQueuedEntry(...args),
    editQueuedEntry: (...args: Parameters<typeof surface.editQueuedEntry>) => current.current.editQueuedEntry(...args),
    deleteQueuedEntry: (...args: Parameters<typeof surface.deleteQueuedEntry>) => current.current.deleteQueuedEntry(...args),
    updateQueuedEntry: (...args: Parameters<typeof surface.updateQueuedEntry>) => current.current.updateQueuedEntry(...args),
    reorderQueuedEntries: (...args: Parameters<typeof surface.reorderQueuedEntries>) => current.current.reorderQueuedEntries(...args),
  }));
  return <ConversationContext.Provider value={context}>
    <QueueCommandsContext.Provider value={commands}>
      <QueueContext.Provider value={surface}>{children}</QueueContext.Provider>
    </QueueCommandsContext.Provider>
  </ConversationContext.Provider>;
}
