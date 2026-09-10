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
  assertAgentGraphIntentClaimRequest,
  type AgentGraphIntentClaim,
  type AgentGraphIntentClaimRequest,
} from '@maka/core/agent-graph-control';
import {
  assertAgentGraphScheduleUpdateRequest,
  AgentGraphScheduleClosedError,
  AgentGraphScheduleRevisionConflictError,
  type AgentGraphScheduleUpdate,
} from '@maka/core/agent-graph-schedule';
import {
  assertResolveAgentGraphEpochRequest,
  assertAdvanceAgentGraphEpochRequest,
  AgentGraphEpochConflictError,
  type AgentGraphEpochBinding,
} from '@maka/core/agent-graph-epoch';
import {
  AgentGraphClientProjectionConflictError,
  AgentGraphClientTerminalCursorError,
  type AgentGraphClientProjectionRecord,
  type AgentGraphClientOperatorProjectionRecord,
  type AgentGraphClientTerminalActivityRecord,
} from '@maka/core/agent-graph-client-projection';
import type {
  AgentGraphSupervisorWakeRecord,
  AgentGraphSupervisorWakeAttemptRecord,
} from '@maka/core/agent-graph-supervisor-wake';
import type { AgentGraphIntentAdmissionSnapshot } from '@maka/core/agent-graph-timeline';
import type { AgentGraphOperatorProvision } from '@maka/core/agent-graph-topology';
import type { ExecutionGraphStore } from '../execution-persistence-provider.js';
import {
  AgentGraphIntentClaimConflictError,
  AgentGraphScheduleUpdateConflictError,
  SessionMetadataConflictError,
  assertSafeSessionId,
} from '../session-store-contract.js';
import {
  assertGraphLookupIdentity,
  assertGraphIntentId,
  assertGraphEventTime,
  assertAgentGraphSupervisorWakeClaim,
  assertAgentGraphSupervisorWakeAttempt,
  assertAgentGraphSupervisorWakeCompletion,
  assertAgentGraphClientProjectionRequest,
  encodeProjectionPayload,
} from '../graph-control-values.js';
import { requireHeader } from './memory-execution-session.js';
import {
  copy,
  equal,
  key,
  rows,
  type MemoryState,
  type MemoryExecutionAuthority,
} from './memory-execution-state.js';

const claims = (s: MemoryState) => rows<AgentGraphIntentClaim>(s, 'graphClaims');
const updates = (s: MemoryState) => rows<AgentGraphScheduleUpdate>(s, 'graphUpdates');
const admissions = (s: MemoryState) =>
  rows<AgentGraphIntentAdmissionSnapshot>(s, 'graphAdmissions');
const epochs = (s: MemoryState) => rows<AgentGraphEpochBinding>(s, 'graphEpochs');
const wakes = (s: MemoryState) => rows<AgentGraphSupervisorWakeRecord>(s, 'graphWakes');
const attempts = (s: MemoryState) =>
  rows<AgentGraphSupervisorWakeAttemptRecord>(s, 'graphWakeAttempts');
const projections = (s: MemoryState) =>
  rows<AgentGraphClientProjectionRecord>(s, 'graphClientProjections');
const operators = (s: MemoryState) =>
  rows<AgentGraphClientOperatorProjectionRecord>(s, 'graphClientOperators');
const terminals = (s: MemoryState) =>
  rows<AgentGraphClientTerminalActivityRecord>(s, 'graphClientTerminals');
const applied = (s: MemoryState) =>
  rows<{ graphId: string; recordId: string; eventTime: number }>(s, 'graphApplied');
function check(...ids: string[]) {
  for (const id of ids) assertGraphLookupIdentity(id, 'identity');
}
function graphRows<T extends { graphId: string }>(table: Map<string, T>, graphId: string): T[] {
  check(graphId);
  return [...table.values()].filter((r) => r.graphId === graphId);
}
function schedule(s: MemoryState, graphId: string) {
  return graphRows(updates(s), graphId).sort((x, y) => x.revision - y.revision);
}
function fence(s: MemoryState, graphId: string, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw new Error('Invalid expected schedule revision');
  const actual = schedule(s, graphId).at(-1)?.revision ?? 0;
  if (actual !== expected)
    throw new AgentGraphScheduleRevisionConflictError(graphId, expected, actual);
}
function claim(s: MemoryState, input: AgentGraphIntentClaimRequest) {
  assertAgentGraphIntentClaimRequest(input);
  const id = key(input.graphId, input.intentId),
    old = claims(s).get(id);
  if (old) {
    if (
      [
        'claimId',
        'intentFingerprint',
        'readinessContextFingerprint',
        'targetOperatorId',
        'targetSessionId',
      ].some((k) => old[k as keyof typeof old] !== input[k as keyof typeof input])
    )
      throw new AgentGraphIntentClaimConflictError(
        'Graph intent identity was reused for different work',
      );
    return { claim: old, created: false };
  }
  if (
    [...claims(s).values()].some(
      (c) =>
        c.claimId === input.claimId ||
        c.targetRunId === input.targetRunId ||
        c.targetTurnId === input.targetTurnId,
    )
  )
    throw new AgentGraphIntentClaimConflictError('Graph claim identity collision');
  const value = { ...copy(input), claimedAt: Date.now() };
  claims(s).set(id, value);
  admissions(s).set(id, {
    graphId: input.graphId,
    intentId: input.intentId,
    state: 'claimed',
    updatedAt: value.claimedAt,
  });
  return { claim: value, created: true };
}
function admission(s: MemoryState, graphId: string, intentId: string) {
  check(graphId);
  assertGraphIntentId(intentId);
  const v = admissions(s).get(key(graphId, intentId));
  if (!v) throw new AgentGraphIntentClaimConflictError('Graph intent has no durable admission');
  return v;
}
function epochList(s: MemoryState, root: string) {
  assertSafeSessionId(root);
  return [...epochs(s).values()]
    .filter((e) => e.rootSessionId === root)
    .sort((x, y) => x.epoch - y.epoch);
}
function wake(s: MemoryState, graphId: string, wakeId: string) {
  check(graphId, wakeId);
  const v = wakes(s).get(key(graphId, wakeId));
  if (!v) throw new SessionMetadataConflictError('Graph wake does not exist');
  return v;
}
function reason(value: string) {
  if (!value.trim() || value.length > 4000)
    throw new Error('Graph reason must be non-empty and bounded');
}
function wakeOrder(x: AgentGraphSupervisorWakeRecord, y: AgentGraphSupervisorWakeRecord) {
  return (
    x.updatedAt - y.updatedAt ||
    x.graphId.localeCompare(y.graphId) ||
    x.wakeId.localeCompare(y.wakeId)
  );
}
function attemptList(s: MemoryState, graphId: string, wakeId: string) {
  check(graphId, wakeId);
  return graphRows(attempts(s), graphId)
    .filter((a) => a.wakeId === wakeId)
    .sort((x, y) => x.startedAt - y.startedAt || x.attemptId.localeCompare(y.attemptId));
}
function payload(value: unknown) {
  return JSON.parse(encodeProjectionPayload(value, 'reference')) as unknown;
}
export function createMemoryGraphStore(a: MemoryExecutionAuthority): ExecutionGraphStore {
  const store: ExecutionGraphStore = {
    close: () => {},
    claimAgentGraphIntent: async (input) => a.write('graph.claim', (s) => claim(s, input)),
    readAgentGraphIntentClaim: async (graphId, intentId) =>
      a.read((s) => {
        check(graphId);
        assertGraphIntentId(intentId);
        return claims(s).get(key(graphId, intentId));
      }),
    listAgentGraphIntentClaims: async (graphId) =>
      a.read((s) =>
        (graphId === undefined ? [...claims(s).values()] : graphRows(claims(s), graphId)).sort(
          (x, y) =>
            x.graphId.localeCompare(y.graphId) ||
            x.claimedAt - y.claimedAt ||
            x.intentId.localeCompare(y.intentId),
        ),
      ),
    claimAgentGraphIntentAtScheduleRevision: async (input, revision) =>
      a.write('graph.claimAtRevision', (s) => {
        assertAgentGraphIntentClaimRequest(input);
        fence(s, input.graphId, revision);
        if (
          !claims(s).has(key(input.graphId, input.intentId)) &&
          schedule(s, input.graphId).some((u) => u.finish)
        )
          throw new AgentGraphScheduleClosedError(input.graphId);
        return claim(s, input);
      }),
    beginAgentGraphIntentExecutionAtScheduleRevision: async (graphId, intentId, revision) =>
      a.write('graph.begin', (s) => {
        fence(s, graphId, revision);
        const old = admission(s, graphId, intentId),
          previousState = old.state;
        if (previousState !== 'claimed')
          return { state: previousState, previousState, changed: false };
        admissions(s).set(key(graphId, intentId), {
          ...old,
          state: 'executing',
          updatedAt: Date.now(),
        });
        return { state: 'executing', previousState, changed: true };
      }),
    cancelAgentGraphIntentExecution: async (graphId, intentId, text) =>
      a.write('graph.cancel', (s) => {
        reason(text);
        const old = admission(s, graphId, intentId),
          previousState = old.state;
        if (previousState === 'cancelled')
          return { state: previousState, previousState, changed: false };
        admissions(s).set(key(graphId, intentId), {
          ...old,
          state: 'cancelled',
          updatedAt: Date.now(),
          cancellationReason: text,
        });
        return { state: 'cancelled', previousState, changed: true };
      }),
    commitAgentGraphScheduleUpdate: async (input) =>
      a.write('graph.schedule', (s) => {
        assertAgentGraphScheduleUpdateRequest(input);
        const old = [...updates(s).values()].find(
          (u) =>
            u.updateId === input.updateId ||
            equal(
              [u.source.sessionId, u.source.runId, u.source.turnId, u.source.toolCallId],
              [
                input.source.sessionId,
                input.source.runId,
                input.source.turnId,
                input.source.toolCallId,
              ],
            ),
        );
        if (old) {
          const { revision: _revision, committedAt: _time, ...request } = old;
          if (!equal(request, input))
            throw new AgentGraphScheduleUpdateConflictError('Graph schedule identity conflict');
          return { update: old, created: false };
        }
        const list = schedule(s, input.graphId);
        if (list.some((u) => u.finish))
          throw new AgentGraphScheduleUpdateConflictError('Graph schedule is already finished');
        const update = {
          ...copy(input),
          revision: (list.at(-1)?.revision ?? 0) + 1,
          committedAt: Date.now(),
        };
        updates(s).set(key(input.graphId, input.updateId), update);
        return { update, created: true };
      }),
    listAgentGraphScheduleUpdates: async (graphId) => a.read((s) => schedule(s, graphId)),
    listAgentGraphOperatorProvisions: async (graphId) =>
      a.read((s) =>
        graphRows(rows<AgentGraphOperatorProvision>(s, 'graphProvisions'), graphId).sort(
          (x, y) => x.provisionedAt - y.provisionedAt || x.workId.localeCompare(y.workId),
        ),
      ),
    resolveCurrentAgentGraphEpoch: async (input) =>
      a.read((s) => {
        assertResolveAgentGraphEpochRequest(input);
        const list = epochList(s, input.rootSessionId);
        if (list.length) {
          if (list[0]!.graphId !== input.legacyGraphId)
            throw new AgentGraphEpochConflictError('Epoch one identity changed');
          return list.at(-1)!;
        }
        if (epochs(s).has(input.legacyGraphId))
          throw new AgentGraphEpochConflictError('Graph belongs to another root');
        return {
          schemaVersion: 1,
          rootSessionId: input.rootSessionId,
          epoch: 1,
          graphId: input.legacyGraphId,
          createdAt: 0,
        };
      }),
    advanceAgentGraphEpoch: async (input) =>
      a.write('graph.advanceEpoch', (s) => {
        assertAdvanceAgentGraphEpochRequest(input);
        const current = epochList(s, input.rootSessionId).at(-1);
        if (current?.epoch === input.expectedEpoch + 1 && current.graphId === input.nextGraphId)
          return current;
        if (!current && input.expectedEpoch === 1) {
          if (epochs(s).has(input.expectedGraphId) || epochs(s).has(input.nextGraphId))
            throw new AgentGraphEpochConflictError('Graph identity collision');
          epochs(s).set(input.expectedGraphId, {
            schemaVersion: 1,
            rootSessionId: input.rootSessionId,
            epoch: 1,
            graphId: input.expectedGraphId,
            createdAt: 0,
          });
        } else if (
          !current ||
          current.epoch !== input.expectedEpoch ||
          current.graphId !== input.expectedGraphId
        )
          throw new AgentGraphEpochConflictError('Graph epoch changed');
        if (epochs(s).has(input.nextGraphId))
          throw new AgentGraphEpochConflictError('Graph identity collision');
        const binding = {
          schemaVersion: 1 as const,
          rootSessionId: input.rootSessionId,
          epoch: input.expectedEpoch + 1,
          graphId: input.nextGraphId,
          createdAt: Date.now(),
        };
        epochs(s).set(binding.graphId, binding);
        return binding;
      }),
    listAgentGraphEpochs: async (root) => a.read((s) => epochList(s, root)),
    readAgentGraphEpochByGraphId: async (graphId) =>
      a.read((s) => {
        check(graphId);
        return epochs(s).get(graphId);
      }),
    listAgentGraphEpochPage: async (input) =>
      a.read((s) => {
        if (
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 256 ||
          (input.beforeEpoch !== undefined &&
            (!Number.isSafeInteger(input.beforeEpoch) || input.beforeEpoch < 1))
        )
          throw new Error('Invalid epoch page');
        const all = epochList(s, input.rootSessionId),
          page = all
            .filter((e) => input.beforeEpoch === undefined || e.epoch < input.beforeEpoch)
            .reverse();
        const selected = page.slice(0, input.limit);
        return {
          epochs: selected,
          currentEpoch: all.at(-1)?.epoch ?? null,
          nextBeforeEpoch: page.length > input.limit ? selected.at(-1)!.epoch : null,
        };
      }),
    claimAgentGraphSupervisorWake: async (input) =>
      a.write('graph.claimWake', (s) => {
        assertAgentGraphSupervisorWakeClaim(input);
        const id = key(input.graphId, input.wakeId),
          old = wakes(s).get(id);
        if (old) {
          if (
            old.snapshotVersion !== input.snapshotVersion ||
            old.rootSessionId !== input.rootSessionId
          )
            throw new SessionMetadataConflictError('Wake identity reused');
          return { wake: old, created: false };
        }
        const now = Date.now(),
          value: AgentGraphSupervisorWakeRecord = {
            ...copy(input),
            status: 'pending',
            attemptCount: 0,
            createdAt: now,
            updatedAt: now,
          };
        wakes(s).set(id, value);
        return { wake: value, created: true };
      }),
    beginAgentGraphSupervisorWakeAttempt: async (input) =>
      a.write('graph.beginWake', (s) => {
        assertAgentGraphSupervisorWakeAttempt(input);
        const old = wake(s, input.graphId, input.wakeId);
        if (old.status !== 'pending' && old.status !== 'retryable_failed')
          return { wake: old, acquired: false };
        const id = key(input.graphId, input.wakeId, input.attemptId);
        if (attempts(s).has(id))
          throw new SessionMetadataConflictError('Wake attempt identity reused');
        const now = Date.now(),
          attempt: AgentGraphSupervisorWakeAttemptRecord = {
            ...copy(input),
            status: 'running',
            startedAt: now,
          };
        const value: AgentGraphSupervisorWakeRecord = {
          ...old,
          status: 'running',
          attemptCount: old.attemptCount + 1,
          currentAttemptId: input.attemptId,
          currentTurnId: input.turnId,
          updatedAt: now,
        };
        delete value.failureReason;
        wakes(s).set(key(input.graphId, input.wakeId), value);
        attempts(s).set(id, attempt);
        return { wake: value, attempt, acquired: true };
      }),
    completeAgentGraphSupervisorWakeAttempt: async (input) =>
      a.write('graph.completeWake', (s) => {
        assertAgentGraphSupervisorWakeCompletion(input);
        const old = wake(s, input.graphId, input.wakeId),
          id = key(input.graphId, input.wakeId, input.attemptId),
          attempt = attempts(s).get(id);
        if (!attempt) throw new SessionMetadataConflictError('Wake attempt absent');
        if (
          old.currentAttemptId !== input.attemptId ||
          attempt.status !== old.status ||
          !['running', 'waiting_permission'].includes(attempt.status)
        ) {
          if (old.status === input.status && attempt.status === input.status) return old;
          throw new SessionMetadataConflictError('Wake attempt no longer current');
        }
        if (attempt.status === 'waiting_permission' && input.status === 'waiting_permission')
          return old;
        const now = Date.now(),
          value = { ...old, status: input.status, updatedAt: now },
          next = { ...attempt, status: input.status };
        delete value.failureReason;
        delete next.failureReason;
        delete next.completedAt;
        if (input.status === 'retryable_failed' || input.status === 'superseded') {
          value.failureReason = input.failureReason;
          next.failureReason = input.failureReason;
        }
        if (input.status !== 'waiting_permission') next.completedAt = now;
        wakes(s).set(key(input.graphId, input.wakeId), value);
        attempts(s).set(id, next);
        return value;
      }),
    supersedeAgentGraphSupervisorWakes: async (input) =>
      a.write('graph.supersedeWakes', (s) => {
        input.rootSessionIds.forEach(assertSafeSessionId);
        input.graphIds?.forEach((id) => check(id));
        reason(input.reason);
        let count = 0;
        const now = Date.now();
        for (const [id, w] of wakes(s)) {
          if (
            !input.rootSessionIds.includes(w.rootSessionId) ||
            (input.graphIds && !input.graphIds.includes(w.graphId))
          )
            continue;
          for (const [aid, attempt] of attempts(s))
            if (
              attempt.graphId === w.graphId &&
              attempt.wakeId === w.wakeId &&
              ['running', 'waiting_permission'].includes(attempt.status)
            ) {
              attempts(s).set(aid, {
                ...attempt,
                status: 'superseded',
                failureReason: input.reason,
                completedAt: now,
              });
            }
          if (['pending', 'running', 'waiting_permission', 'retryable_failed'].includes(w.status)) {
            wakes(s).set(id, {
              ...w,
              status: 'superseded',
              failureReason: input.reason,
              updatedAt: now,
            });
            count++;
          }
        }
        return count;
      }),
    readAgentGraphSupervisorWake: async (graphId, wakeId) =>
      a.read((s) => {
        check(graphId, wakeId);
        return wakes(s).get(key(graphId, wakeId));
      }),
    listAgentGraphSupervisorWakeAttempts: async (graphId, wakeId) =>
      a.read((s) => attemptList(s, graphId, wakeId)),
    listUnsettledAgentGraphSupervisorWakes: async () =>
      a.read((s) =>
        [...wakes(s).values()]
          .filter((w) => w.status === 'running' || w.status === 'waiting_permission')
          .sort(wakeOrder),
      ),
    listRetryableAgentGraphSupervisorWakes: async () =>
      a.read((s) =>
        [...wakes(s).values()].filter((w) => w.status === 'retryable_failed').sort(wakeOrder),
      ),
    recoverAgentGraphSupervisorWakes: async () =>
      a.write('graph.recoverWakes', (s) => {
        let count = 0;
        for (const [id, w] of wakes(s))
          if (w.status === 'pending') {
            wakes(s).set(id, {
              ...w,
              status: 'retryable_failed',
              failureReason: 'host_restart',
              updatedAt: Date.now(),
            });
            count++;
          }
        return count;
      }),
    commitAgentGraphClientProjection: async (input) =>
      a.write('graph.project', (s) => {
        assertAgentGraphClientProjectionRequest(input);
        requireHeader(s, input.rootSessionId);
        const current = projections(s).get(input.graphId);
        if ((current?.snapshotVersion ?? null) !== input.expectedSnapshotVersion)
          throw new AgentGraphClientProjectionConflictError('Graph projection version conflict');
        if (input.incrementalRecordId) {
          const old = applied(s).get(key(input.graphId, input.incrementalRecordId));
          if (old) {
            if (
              old.eventTime !==
              input.activityRecords.find((r) => r.recordId === input.incrementalRecordId)!.eventTime
            )
              throw new SessionMetadataConflictError('Applied graph activity changed');
            if (!current) throw new Error('Incremental graph projection missing');
            return current;
          }
        }
        const now = Date.now(),
          value: AgentGraphClientProjectionRecord = {
            schemaVersion: 1,
            graphId: input.graphId,
            rootSessionId: input.rootSessionId,
            snapshotVersion: input.snapshotVersion,
            payload: payload(input.snapshot),
            materializedAt: now,
          };
        projections(s).set(input.graphId, value);
        for (const record of input.activityRecords) {
          const id = key(input.graphId, record.recordId),
            old = applied(s).get(id);
          if (old && old.eventTime !== record.eventTime)
            throw new SessionMetadataConflictError('Applied graph activity changed');
          applied(s).set(id, { graphId: input.graphId, ...copy(record) });
        }
        if (input.replaceOperators)
          for (const [id, o] of operators(s))
            if (o.graphId === input.graphId) operators(s).delete(id);
        for (const o of input.operators)
          operators(s).set(key(input.graphId, o.operatorId), {
            graphId: input.graphId,
            operatorId: o.operatorId,
            snapshotVersion: input.snapshotVersion,
            payload: payload(o.payload),
            materializedAt: now,
          });
        for (const t of input.terminalActivities) {
          const id = key(input.graphId, t.recordId),
            old = terminals(s).get(id),
            value = {
              graphId: input.graphId,
              recordId: t.recordId,
              eventTime: t.eventTime,
              payload: payload(t.payload),
            };
          if (old && !equal(old, value))
            throw new SessionMetadataConflictError('Graph terminal activity changed');
          terminals(s).set(id, value);
        }
        return value;
      }),
    readAgentGraphClientProjection: async (graphId) =>
      a.read((s) => {
        check(graphId);
        return projections(s).get(graphId);
      }),
    readAgentGraphClientOperatorProjection: async (graphId, operatorId) =>
      a.read((s) => {
        check(graphId, operatorId);
        return operators(s).get(key(graphId, operatorId));
      }),
    readAgentGraphClientProjectionWithOperator: async (graphId, operatorId) =>
      a.read((s) => {
        check(graphId, operatorId);
        const projection = projections(s).get(graphId),
          operator = operators(s).get(key(graphId, operatorId));
        return projection ? { projection, ...(operator ? { operator } : {}) } : undefined;
      }),
    listAgentGraphClientTerminalActivities: async (graphId, input) =>
      a.read((s) => {
        check(graphId);
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256)
          throw new Error('Invalid graph activity limit');
        const before = input.before;
        if (before) {
          assertGraphEventTime(before.eventTime);
          check(before.recordId);
          if (terminals(s).get(key(graphId, before.recordId))?.eventTime !== before.eventTime)
            throw new AgentGraphClientTerminalCursorError('Graph activity cursor stale');
        }
        const all = graphRows(terminals(s), graphId)
          .filter(
            (t) =>
              !before ||
              t.eventTime < before.eventTime ||
              (t.eventTime === before.eventTime && t.recordId < before.recordId),
          )
          .sort((x, y) => y.eventTime - x.eventTime || y.recordId.localeCompare(x.recordId));
        return { records: all.slice(0, input.limit), hasMore: all.length > input.limit };
      }),
    listAgentGraphClientClaimAdmissions: async (graphId) =>
      a.read((s) =>
        graphRows(admissions(s), graphId)
          .sort((x, y) => x.intentId.localeCompare(y.intentId))
          .map((r) => ({ intentId: r.intentId, state: r.state })),
      ),
    readAgentGraphTimelineMetadata: async (graphId) =>
      a.read((s) => ({
        graphId,
        scheduleUpdates: schedule(s, graphId),
        operatorProvisions: graphRows(
          rows<AgentGraphOperatorProvision>(s, 'graphProvisions'),
          graphId,
        ),
        intentClaims: graphRows(claims(s), graphId),
        intentAdmissions: graphRows(admissions(s), graphId),
        supervisorWakes: graphRows(wakes(s), graphId).map((w) => ({
          wake: w,
          attempts: attemptList(s, graphId, w.wakeId),
        })),
      })),
    listTombstonedSessionIdsAmong: async (ids) =>
      a.read((s) => {
        ids.forEach(assertSafeSessionId);
        return [...new Set(ids)].filter((id) => rows(s, 'tombstones').has(id)).sort();
      }),
    purgeAgentGraphControlState: async (graphId) =>
      a.write('graph.purge', (s) => {
        check(graphId);
        let count = 0;
        for (const name of [
          'graphClaims',
          'graphAdmissions',
          'graphUpdates',
          'graphProvisions',
          'graphWakes',
          'graphWakeAttempts',
          'graphClientProjections',
          'graphClientOperators',
          'graphClientTerminals',
          'graphApplied',
        ]) {
          const table = rows<{ graphId: string }>(s, name);
          for (const [id, row] of table)
            if (row.graphId === graphId) {
              table.delete(id);
              count++;
            }
        }
        return count;
      }),
    purgeAgentGraphEpochs: async (root) =>
      a.write('graph.purgeEpochs', (s) => {
        assertSafeSessionId(root);
        let count = 0;
        for (const [id, e] of epochs(s))
          if (e.rootSessionId === root) {
            epochs(s).delete(id);
            count++;
          }
        return count;
      }),
  };
  return store;
}
