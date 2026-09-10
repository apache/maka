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

import {
  normalizeAdmitRootTurnInput,
  normalizeRootTurnStartRejection,
  rootTurnAdmissionPayloadsEqual,
  orderRootTurnAdmissionChain,
  assertSafeId,
  shouldPreserveCheckpointProjectionDuringAppend,
  shouldPreserveProjectionDuringRepair,
  isProjectedAgentRunEvent,
  latestContextOrder,
  sanitizeJson,
  type DurableAgentRunStore,
  type RootTurnAdmission,
  type RootTurnStartRejection,
} from '../agent-run-store-contract.js';
import { decodeAgentRunEvent } from '../execution-record-codec.js';
import {
  assertEvidenceReadBudget,
  type EvidenceReadBudget,
  type BoundedEvidenceReadResult,
} from '../bounded-evidence.js';
import {
  LATEST_CONTEXT_PROJECTION_TYPE,
  RUN_COMPOSITION_RECORDED_EVENT_TYPE,
  supersedesLatestContext,
  type AgentRunEvent,
} from '@maka/core/agent-run';
import { runtimeEventInvocationOpening, type RuntimeEvent } from '@maka/core/runtime-event';
import { isSessionInlineInvocation } from '@maka/core/runtime-invocation';
import {
  copy,
  equal,
  key,
  rows,
  type MemoryState,
  type MemoryExecutionAuthority,
} from './memory-execution-state.js';

export function bounded<T>(
  records: readonly T[],
  budget: EvidenceReadBudget,
): BoundedEvidenceReadResult<T> {
  assertEvidenceReadBudget(budget);
  const storedBytes = records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
  return records.length > budget.maxRecords || storedBytes > budget.maxBytes
    ? { status: 'limit_exceeded' }
    : { status: 'complete', records, sourceRecordCount: records.length, storedBytes };
}
const events = (s: MemoryState) => rows<AgentRunEvent[]>(s, 'agentEvents');
const roots = (s: MemoryState) => rows<RootTurnAdmission>(s, 'rootAdmissions');
const rejected = (s: MemoryState) => rows<RootTurnStartRejection>(s, 'rootRejections');
const projections = (s: MemoryState) => rows<AgentRunEvent | null>(s, 'agentProjections');
function check(...ids: string[]) {
  for (const id of ids) assertSafeId(id, 'Invalid execution identity');
}
function revision(s: MemoryState, sessionId: string) {
  return JSON.stringify(
    [...events(s).values()]
      .filter((e) => e[0]?.sessionId === sessionId)
      .map((e) => [e[0]!.runId, e.length, e.length - 1])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
  );
}
export function memoryRootSourceReceipt(s: MemoryState, sessionId: string, messageId: string) {
  check(sessionId, messageId);
  for (const admission of roots(s).values()) {
    if (admission.sessionId !== sessionId) continue;
    const sourceMessage = admission.sourceMessages.find((m) => m.messageId === messageId);
    if (sourceMessage) return { admission, sourceMessage };
  }
  return undefined;
}
export function createMemoryAgentRunStore(a: MemoryExecutionAuthority): DurableAgentRunStore {
  const store: DurableAgentRunStore = {
    ready: async () => {},
    close: () => {},
    appendEvent: async (sessionId, runId, input, options = {}) =>
      a.write('agent.append', (s) => {
        check(sessionId, runId);
        const openingEvent = rows<RuntimeEvent[]>(s, 'runtimeEvents')
          .get(key(sessionId, runId))
          ?.find((e) => runtimeEventInvocationOpening(e));
        const opening = openingEvent && runtimeEventInvocationOpening(openingEvent);
        if (!opening)
          throw Object.assign(new Error('Agent run does not exist: ' + runId), { code: 'ENOENT' });
        const event = decodeAgentRunEvent(JSON.parse(JSON.stringify(input, sanitizeJson)), {
          sessionId,
          runId,
          turnId: openingEvent!.turnId,
        });
        const id = key(sessionId, runId),
          list = events(s).get(id) ?? [];
        const existing =
          event.type === RUN_COMPOSITION_RECORDED_EVENT_TYPE
            ? list.find((e) => e.type === event.type)
            : undefined;
        if (existing) {
          if (!equal(existing.data, event.data))
            throw new Error('AgentRun Run Composition is immutable');
          return;
        }
        // The AgentRun ledger is append ordered; only Run Composition is write-once.
        list.push(event);
        events(s).set(id, list);
        const checkpoint = key(sessionId, 'history_compact_checkpoint_recorded');
        if (!projections(s).has(checkpoint)) projections(s).set(checkpoint, null);
        if (
          event.type === 'history_compact_checkpoint_recorded' &&
          !shouldPreserveCheckpointProjectionDuringAppend(projections(s).get(checkpoint), event)
        ) {
          projections(s).set(checkpoint, event);
        }
        if (options.latestContext && isSessionInlineInvocation(opening)) {
          const latest = options.latestContext,
            pkey = key(sessionId, LATEST_CONTEXT_PROJECTION_TYPE);
          const current = projections(s).get(pkey),
            currentOrder = current && latestContextOrder(current);
          if (
            !currentOrder ||
            supersedesLatestContext(
              { completedAt: latest.orderedAt, attemptId: String(latest.attemptId) },
              currentOrder,
            )
          ) {
            projections(s).set(pkey, {
              ...event,
              type: LATEST_CONTEXT_PROJECTION_TYPE,
              id: 'latest-context-' + latest.attemptId,
              data: copy(latest.snapshot),
            });
          }
        }
      }),
    readEvents: async (sessionId, runId) => store.readEventsForRecovery(sessionId, runId),
    readEventsForRecovery: async (sessionId, runId) =>
      a.read((s) => {
        check(sessionId, runId);
        return events(s).get(key(sessionId, runId)) ?? [];
      }),
    readEventsForEvidence: async (sessionId, runId) =>
      store.readEventsForRecovery(sessionId, runId),
    readEventsBounded: async (sessionId, runId, budget) =>
      bounded(await store.readEventsForRecovery(sessionId, runId), budget),
    readEventsByTypeBounded: async (sessionId, runId, type, budget) =>
      bounded(
        (await store.readEventsForRecovery(sessionId, runId)).filter((e) => e.type === type),
        budget,
      ),
    readEventProjection: async (sessionId, type) =>
      a.read((s) => {
        check(sessionId);
        return projections(s).get(key(sessionId, type));
      }),
    readEventLedgerRevision: async (sessionId) =>
      a.read((s) => {
        check(sessionId);
        return revision(s, sessionId);
      }),
    repairEventProjection: async (sessionId, type, event, options) =>
      a.write('agent.repairProjection', (s) => {
        check(sessionId);
        if (!options || typeof options.ifLedgerRevision !== 'string')
          throw new Error('Projection repair requires ledger revision');
        if (event !== null && !isProjectedAgentRunEvent(event, sessionId, type))
          throw new Error('Invalid projection repair');
        if (revision(s, sessionId) !== options.ifLedgerRevision) return;
        const id = key(sessionId, type),
          current = projections(s).get(id);
        if (
          current?.id !== options.replaceEventId &&
          shouldPreserveProjectionDuringRepair(current, event, type)
        )
          return;
        projections(s).set(id, copy(event));
      }),
    admitRootTurn: async (input) =>
      a.write('agent.admitRoot', (s) => {
        const admission = normalizeAdmitRootTurnInput(copy(input)),
          id = key(admission.sessionId, admission.turnId);
        const old = roots(s).get(id);
        if (old)
          return {
            kind:
              old.previousRootTurnId === admission.previousRootTurnId &&
              rootTurnAdmissionPayloadsEqual(old, admission)
                ? 'existing'
                : 'conflict',
            admission: old,
          };
        if (rejected(s).has(id)) throw new Error('Root Turn identity is already rejected');
        const execution = admission.execution;
        if (execution.kind === 'safe_boundary_continuation') {
          const owner = [...roots(s).values()].find(
            (r) =>
              r.sessionId === admission.sessionId &&
              r.execution.kind === 'safe_boundary_continuation' &&
              r.execution.sourceTurnId === execution.sourceTurnId &&
              r.execution.sourceRunId === execution.sourceRunId,
          );
          if (owner) return { kind: 'conflict', admission: owner };
        }
        for (const source of admission.sourceMessages) {
          const owner = memoryRootSourceReceipt(s, admission.sessionId, source.messageId);
          if (owner)
            throw new Error(
              'Root source message identity already belongs to ' + owner.admission.turnId,
            );
        }
        roots(s).set(id, admission);
        return { kind: 'admitted', admission };
      }),
    readRootTurnAdmission: async (sessionId, turnId) =>
      a.read((s) => {
        check(sessionId, turnId);
        return roots(s).get(key(sessionId, turnId));
      }),
    readRootTurnContinuationAdmission: async (sessionId, sourceTurnId, sourceRunId) =>
      a.read((s) => {
        check(sessionId, sourceTurnId, sourceRunId);
        return [...roots(s).values()].find(
          (r) =>
            r.sessionId === sessionId &&
            r.execution.kind === 'safe_boundary_continuation' &&
            r.execution.sourceTurnId === sourceTurnId &&
            r.execution.sourceRunId === sourceRunId,
        );
      }),
    readRootTurnSourceMessageReceipt: async (sessionId, messageId) =>
      a.read((s) => memoryRootSourceReceipt(s, sessionId, messageId)),
    listRootTurnAdmissionsForRecovery: async (sessionId) =>
      a.read((s) => {
        check(sessionId);
        return orderRootTurnAdmissionChain(
          sessionId,
          [...roots(s).values()]
            .filter((r) => r.sessionId === sessionId)
            .sort((x, y) => x.admittedAt - y.admittedAt || x.turnId.localeCompare(y.turnId)),
        );
      }),
    readRootTurnStartRejection: async (sessionId, turnId) =>
      a.read((s) => {
        check(sessionId, turnId);
        return rejected(s).get(key(sessionId, turnId));
      }),
    commitRootTurnStartRejection: async (input) =>
      a.write('agent.rejectRoot', (s) => {
        const rejection = normalizeRootTurnStartRejection(copy(input)),
          id = key(rejection.sessionId, rejection.turnId);
        if (roots(s).has(id)) throw new Error('Root Turn identity is already admitted');
        const old = rejected(s).get(id);
        if (old)
          return {
            kind:
              equal(old.execution, rejection.execution) &&
              equal(old.skillInvocation, rejection.skillInvocation)
                ? 'existing'
                : 'conflict',
            rejection: old,
          };
        rejected(s).set(id, rejection);
        return { kind: 'committed', rejection };
      }),
  };
  return store;
}
