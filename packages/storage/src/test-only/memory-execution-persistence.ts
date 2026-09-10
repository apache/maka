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

import type {
  ExecutionPersistenceProvider,
  ExecutionPersistence,
} from '../execution-persistence-provider.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ToolOperationRecord } from '../runtime-event-store-contract.js';
import type { ContinuationClaimStateV1 } from '@maka/core/runtime-event-store';
import { WORKSPACE_AUTHORITY_SESSION_ID } from '@maka/core/workspace-version-authority';
import { assertSafeStorageId } from '../storage-id.js';
import { createMemorySessionStore } from './memory-execution-session.js';
import { createMemoryAgentRunStore } from './memory-execution-agent.js';
import { createMemoryRuntimeStore } from './memory-execution-runtime.js';
import { createMemoryGraphStore } from './memory-execution-graph.js';
import { createMemoryInteractionStore, createMemoryGoalStore } from './memory-execution-control.js';
import {
  MemoryExecutionAuthority,
  rows,
  type MemoryExecutionFaults,
} from './memory-execution-state.js';

/**
 * Independent, process-lifetime reference authority for conformance/Host tests.
 * No SQLite handles, files, default-provider fallback, or product configuration.
 * Reopening this provider retains facts; restarting the process does NOT.
 * Whole-state copying favors an inspectable transaction model over performance.
 */
export function createMemoryExecutionPersistenceProvider(
  faults: MemoryExecutionFaults = {},
): ExecutionPersistenceProvider {
  const roots = new Map<string, { canonicalPath: string; authority: MemoryExecutionAuthority }>();
  return Object.freeze({
    async open(
      input: Parameters<ExecutionPersistenceProvider['open']>[0],
    ): Promise<ExecutionPersistence> {
      let root = roots.get(input.rootId);
      if (root && root.canonicalPath !== input.canonicalPath)
        throw new Error('Reference root identity changed');
      if (!root) {
        root = {
          canonicalPath: input.canonicalPath,
          authority: new MemoryExecutionAuthority(faults),
        };
        roots.set(input.rootId, root);
      }
      const authority = root.authority;
      let closed = false;
      function scoped<T extends object>(port: T): T {
        return new Proxy(port, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (closed && property !== 'close')
                throw new Error('Reference execution persistence is closed');
              return Reflect.apply(value, target, args);
            };
          },
        });
      }
      return {
        sessionStore: scoped(createMemorySessionStore(authority, input.canonicalPath)),
        agentRunStore: scoped(createMemoryAgentRunStore(authority)),
        runtimeEventStore: scoped(createMemoryRuntimeStore(authority)),
        graphControlStore: scoped(createMemoryGraphStore(authority)),
        interactionStore: scoped(createMemoryInteractionStore(authority)),
        goalStore: scoped(createMemoryGoalStore(authority)),
        async purgeConversationOperationalState(sessionId) {
          if (closed) throw new Error('Reference execution persistence is closed');
          assertSafeStorageId(sessionId);
          if (sessionId === WORKSPACE_AUTHORITY_SESSION_ID)
            throw new Error('Workspace authority cannot be purged as a conversation');
          authority.write('execution.purgeOperational', (s) => {
            const eventIds = new Set(
              [...rows<RuntimeEvent[]>(s, 'runtimeEvents').values()]
                .flat()
                .filter((e) => e.sessionId === sessionId)
                .map((e) => e.id),
            );
            const operations = rows<ToolOperationRecord>(s, 'toolOperations');
            const removedOperations = new Set<string>();
            for (const [id, operation] of operations) {
              if (
                [operation.callEventId, operation.dispatchEventId, operation.resultEventId].some(
                  (eventId) => eventId !== undefined && eventIds.has(eventId),
                )
              ) {
                operations.delete(id);
                removedOperations.add(id);
              }
            }
            const journal = rows<{ operationId: string; eventId: string }>(s, 'toolJournal');
            for (const [id, entry] of journal)
              if (removedOperations.has(entry.operationId) || eventIds.has(entry.eventId))
                journal.delete(id);
            const claims = rows<ContinuationClaimStateV1>(s, 'continuationClaims');
            for (const [id, claim] of claims)
              if (claim.startEventId && eventIds.has(claim.startEventId)) claims.delete(id);
            // Null projection rows still belong to the Session identified by their key.
            const projections = rows(s, 'agentProjections');
            for (const id of projections.keys())
              if (JSON.parse(id)[0] === sessionId) projections.delete(id);
            for (const name of [
              'rootAdmissions',
              'rootRejections',
              'agentEvents',
              'runtimeEvents',
              'runtimePartials',
              'runtimeOrdinals',
              'clientGrants',
              'goals',
            ]) {
              const table = rows<unknown>(s, name);
              for (const [id, value] of table) {
                const record = Array.isArray(value) ? value[0] : value;
                const identified = record as {
                  sessionId?: string;
                  event?: { sessionId: string };
                  request?: { sessionId: string };
                } | null;
                if (
                  id === sessionId ||
                  identified?.sessionId === sessionId ||
                  identified?.event?.sessionId === sessionId ||
                  identified?.request?.sessionId === sessionId
                )
                  table.delete(id);
              }
            }
          });
        },
        async close() {
          closed = true;
        },
      };
    },
  });
}
