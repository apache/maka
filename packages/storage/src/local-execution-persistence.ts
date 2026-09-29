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

import { createSessionStore } from './session-store.js';
import { createSqliteAgentRunStore } from './agent-run-store.js';
import { openRuntimeEventPersistence } from './runtime-event-persistence.js';
import { createConversationOperationalStateStore } from './conversation-operational-state.js';
import { createAgentGraphControlStore } from './agent-graph-control-store.js';
import { createSqliteGoalAuthority } from './goal-authority.js';
import { createSqliteInteractionStore } from './interaction-store.js';
import type { ExecutionPersistenceProvider } from './execution-persistence-provider.js';
import { exportSessionBundleState } from './session-bundle-policy.js';
import { createSessionSnapshotStateIdentity } from './production-session-snapshot.js';
import { runWithStorageRootLease, type StorageRootLease } from './root-authority.js';
import type { SessionSnapshotStatePreparer } from './quiescent-session-snapshot.js';

export const localExecutionPersistenceProvider: ExecutionPersistenceProvider = Object.freeze({
  async open({ canonicalPath }: { canonicalPath: string }) {
    const closes: Array<() => void | Promise<void>> = [];
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        const errors: unknown[] = [];
        for (const dispose of [...closes].reverse()) {
          try {
            await dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, 'Unable to close local execution persistence');
      })());
    try {
      const sessionStore = createSessionStore(canonicalPath);
      closes.push(() => sessionStore.close?.());
      const agentRunStore = createSqliteAgentRunStore(canonicalPath);
      closes.push(() => agentRunStore.close?.());
      const runtime = await openRuntimeEventPersistence({ workspaceRoot: canonicalPath });
      closes.push(() => runtime.close());
      const operational = createConversationOperationalStateStore(canonicalPath);
      closes.push(() => operational.close());
      const graphControlStore = createAgentGraphControlStore(canonicalPath);
      closes.push(() => graphControlStore.close());
      const goalStore = createSqliteGoalAuthority(canonicalPath);
      closes.push(() => goalStore.close());
      const interactionStore = createSqliteInteractionStore(canonicalPath);
      closes.push(() => interactionStore.close());
      await Promise.all([sessionStore.ready(), agentRunStore.ready?.(), interactionStore.ready()]);
      return {
        createSnapshotStatePreparer(
          lease: StorageRootLease<'interactive', 'write'>,
        ): SessionSnapshotStatePreparer {
          if (lease.canonicalPath !== canonicalPath)
            throw new Error('Snapshot lease belongs to another backend');
          return {
            async prepareState(input) {
              input.cancellation.signal.throwIfAborted();
              // Lock order: execution fence -> Artifact writer -> context values.
              // The exporter holds the Artifact lock until both databases and
              // their payloads are private. GC/publication uses these same locks.
              await runWithStorageRootLease(lease, 'interactive', 'write', () =>
                exportSessionBundleState({
                  stateRoot: canonicalPath,
                  configRoot: canonicalPath,
                  allowShared: true,
                  destinationRoot: input.destinationRoot,
                  sessionId: input.makaSessionId,
                  requireQuiescent: true,
                  lease,
                }),
              );
              input.cancellation.signal.throwIfAborted();
              return createSessionSnapshotStateIdentity(input.makaSessionId);
            },
          };
        },
        sessionStore,
        agentRunStore,
        runtimeEventStore: runtime.runtimeEventStore,
        graphControlStore,
        goalStore,
        interactionStore,
        purgeConversationOperationalState: (sessionId: string) => operational.purge(sessionId),
        close,
      };
    } catch (error) {
      try {
        await close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'Unable to open local execution persistence');
      }
      throw error;
    }
  },
});
