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

import { createHash } from 'node:crypto';
import { EventWaitAdapterRegistry } from '../../server/event-wait-adapter.js';
import { HostEventWaitObserver } from '../../server/event-wait-manager.js';
import type { MatterStore } from './matter.js';
import type { AssistantModuleServices } from '../service.js';
import { conditionReader, runCondition, type ConditionReader } from './condition.js';

/** Observation never runs an Agent/model; it only executes an already tested read-only cell. */
export function createMatterObserver(
  ctx: AssistantModuleServices,
  store: MatterStore,
  owner: string,
  onError: (error: unknown) => void,
  options: {
    reader?: (sessionId: string) => ConditionReader;
    policy?: ConstructorParameters<typeof HostEventWaitObserver>[0]['policy'];
    clock?: ConstructorParameters<typeof HostEventWaitObserver>[0]['clock'];
  } = {},
) {
  return new HostEventWaitObserver({
    store: store.conditions.observationStore(owner),
    policy: { maxLifetimeMs: 366 * 86400000, maxAttempts: 1_000_000, ...options.policy },
    ...(options.clock ? { clock: options.clock } : {}),
    onError,
    authorize: async (wait) => {
      const m = store.get(wait.resource.resourceId).matter;
      return m.conditionWaitId === wait.waitId && m.status === 'waiting' && !m.activation
        ? { kind: 'allowed', context: null }
        : { kind: 'revoked', reason: 'matter_wait_superseded' };
    },
    adapters: new EventWaitAdapterRegistry([
      {
        providerId: 'matter',
        resourceType: 'checker',
        conditionType: 'code',
        conditionVersion: 1,
        reconciliation: 'snapshot',
        validate(wait) {
          store.conditions.checker(
            String(wait.condition.parameters.checkerId),
            wait.resource.resourceId,
          );
        },
        async read({ wait, cursor, signal }) {
          if ((wait.observation?.consecutiveErrors ?? 0) >= 3)
            return {
              kind: 'source_unavailable',
              receiptKey: `checker-errors:${wait.waitId}`,
              evidenceRefs: [
                'Checker repeatedly failed or timed out. Retest its code and source permissions.',
              ],
            };
          const checker = store.conditions.checker(
            String(wait.condition.parameters.checkerId),
            wait.resource.resourceId,
          );
          const cwd = store.binding(wait.sessionId);
          if (!cwd) throw new Error('Matter session is unavailable');
          const reader =
            options.reader?.(wait.sessionId) ??
            conditionReader(ctx, {
              sessionId: wait.sessionId,
              cwd,
              turnId: wait.sourceTurnId,
              toolCallId: `condition:${wait.waitId}`,
            });
          try {
            const result = await runCondition(
              checker.definition,
              cursor ? JSON.parse(cursor) : null,
              reader,
              signal,
            );
            signal.throwIfAborted();
            if (result.status === 'pending')
              return { kind: 'pending', cursor: JSON.stringify(result.checkpoint ?? {}) };
            return {
              kind: 'satisfied',
              receiptKey: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
              evidenceRefs: [result.reason, ...result.evidence],
            };
          } catch (error) {
            signal.throwIfAborted();
            // A broken checker wakes the owner for repair; it never pauses or completes the task.
            if ((wait.observation?.consecutiveErrors ?? 0) >= 2)
              return {
                kind: 'source_unavailable',
                receiptKey: `checker-errors:${wait.waitId}`,
                evidenceRefs: [
                  'Checker failed repeatedly. Retest the checker and its source permissions before waiting again.',
                ],
              };
            return { kind: 'unknown', reason: 'checker_failed' };
          }
        },
      },
    ]),
  });
}
